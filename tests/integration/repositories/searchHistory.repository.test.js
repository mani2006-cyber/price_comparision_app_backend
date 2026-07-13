// tests/integration/repositories/searchHistory.repository.test.js
//
// Integration test for searchHistory.repository.js. Covers the merge/
// bump-to-top upsert design (File 21 revision) - repeating an identical
// search updates the existing row instead of creating a duplicate - and
// the retention-cap trimming that keeps each user's history bounded.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const SearchHistory = require('../../../src/models/SearchHistory.model');
const searchHistoryRepository = require('../../../src/repositories/searchHistory.repository');

const TEST_EMAIL = 'repotest-searchhistory@example.com';

let user;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await User.deleteMany({ email: TEST_EMAIL });
    user = await User.create({ name: 'Search Repo Test', email: TEST_EMAIL, password: 'plaintext123' });
    await SearchHistory.deleteMany({ userId: user._id });
});

function wait(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

describe('recordSearch - merge behavior', function() {
    it('merges repeated identical searches into ONE row, incrementing searchCount', async function() {
        await searchHistoryRepository.recordSearch(user._id, 'iphone', 10, null, 20);
        await wait(10);
        await searchHistoryRepository.recordSearch(user._id, 'iPhone', 16, null, 20); // different casing
        await wait(10);
        await searchHistoryRepository.recordSearch(user._id, ' iphone ', 12, null, 20); // whitespace

        const rows = await SearchHistory.find({ userId: user._id });
        expect(rows).toHaveLength(1);
        expect(rows[0].searchCount).toBe(3);
        expect(rows[0].resultCount).toBe(12); // from the LATEST search, not summed
    });

    it('keeps distinct searches as separate rows, sorted most-recent-first', async function() {
        await searchHistoryRepository.recordSearch(user._id, 'iphone', 10, null, 20);
        await wait(10);
        await searchHistoryRepository.recordSearch(user._id, 'laptop', 8, null, 20);

        const list = await searchHistoryRepository.findByUser(user._id);
        expect(list).toHaveLength(2);
        expect(list[0].query).toBe('laptop'); // most recently searched, bumped to top
        expect(list[1].query).toBe('iphone');
    });
});

describe('trimToLimit', function() {
    it('keeps only the N most-recently-searched rows, discarding older ones', async function() {
        for (let i = 1; i <= 5; i++) {
            await searchHistoryRepository.recordSearch(user._id, 'query-' + i, i * 2, null, 3);
            await wait(10);
        }

        const remaining = await SearchHistory.find({ userId: user._id }).sort({ lastSearchedAt: -1 });
        expect(remaining).toHaveLength(3);
        expect(remaining.map(function(r) { return r.query; })).toEqual(['query-5', 'query-4', 'query-3']);
    });
});

describe('removeByIdForUser - ownership scoping', function() {
    it('only deletes when called by the entry\'s actual owner', async function() {
        const otherUser = await User.create({ name: 'Other', email: 'repotest-searchhistory-other@example.com', password: 'plaintext123' });

        const row = await searchHistoryRepository.recordSearch(user._id, 'iphone', 10, null, 20);

        const wrongDelete = await searchHistoryRepository.removeByIdForUser(row._id, otherUser._id);
        expect(wrongDelete.deletedCount).toBe(0);

        const correctDelete = await searchHistoryRepository.removeByIdForUser(row._id, user._id);
        expect(correctDelete.deletedCount).toBe(1);

        await User.deleteOne({ _id: otherUser._id });
    });
});