// tests/integration/models/SearchHistory.test.js
//
// Integration test for SearchHistory.model.js. Covers the merge/bump-
// to-top design added mid-project: repeating an identical search should
// update the existing row (unique index on userId+query+platform), not
// create a duplicate.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const SearchHistory = require('../../../src/models/SearchHistory.model');

const TEST_EMAIL = 'modeltest-searchhistory@example.com';

let user;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await User.deleteMany({ email: TEST_EMAIL });
    user = await User.create({ name: 'Search History Test', email: TEST_EMAIL, password: 'plaintext123' });
    await SearchHistory.deleteMany({ userId: user._id });
});

describe('SearchHistory model', function() {
    it('lowercases the query automatically', async function() {
        const row = await SearchHistory.create({ userId: user._id, query: 'iPhone', resultCount: 16 });
        expect(row.query).toBe('iphone');
    });

    it('rejects a true duplicate: same user, same query, same platform', async function() {
        await SearchHistory.create({ userId: user._id, query: 'iphone', resultCount: 16 });

        await expect(
            SearchHistory.create({ userId: user._id, query: 'iphone', resultCount: 20 })
        ).rejects.toMatchObject({ code: 11000 });
    });

    it('allows the same query scoped to a DIFFERENT platform', async function() {
        await SearchHistory.create({ userId: user._id, query: 'iphone', resultCount: 16 });
        const scoped = await SearchHistory.create({ userId: user._id, query: 'iphone', platform: 'amazon', resultCount: 8 });

        expect(scoped._id).toBeDefined();
    });

    it('searchCount defaults to 1 on creation', async function() {
        const row = await SearchHistory.create({ userId: user._id, query: 'laptop' });
        expect(row.searchCount).toBe(1);
    });
});