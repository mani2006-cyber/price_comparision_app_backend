// tests/integration/models/RefreshToken.test.js
//
// Integration test for RefreshToken.model.js. Covers deterministic
// hashing (never store the raw token), and the revoke + link-to-
// replacement sequence that auth.service.js's rotation and reuse-
// detection logic depends on (File 37).

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const RefreshToken = require('../../../src/models/RefreshToken.model');

const TEST_EMAIL = 'modeltest-refreshtoken@example.com';

let user;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await User.deleteMany({ email: TEST_EMAIL });
    user = await User.create({ name: 'Refresh Token Test', email: TEST_EMAIL, password: 'plaintext123' });
    await RefreshToken.deleteMany({ userId: user._id });
});

describe('RefreshToken model', function() {
    it('hashToken is deterministic and never equals the raw token', function() {
        const raw = 'some-random-refresh-token-value';
        const hash1 = RefreshToken.hashToken(raw);
        const hash2 = RefreshToken.hashToken(raw);

        expect(hash1).toBe(hash2);
        expect(hash1).not.toBe(raw);
    });

    it('creates a record that can be looked up by its hash', async function() {
        const raw = 'raw-token-' + Date.now();
        await RefreshToken.create({
            userId: user._id,
            tokenHash: RefreshToken.hashToken(raw),
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        const found = await RefreshToken.findOne({ tokenHash: RefreshToken.hashToken(raw) });
        expect(found).not.toBeNull();
        expect(found.revoked).toBe(false);
    });

    it('rejects a duplicate tokenHash via the unique index', async function() {
        const hash = RefreshToken.hashToken('same-token-value');
        await RefreshToken.create({ userId: user._id, tokenHash: hash, expiresAt: new Date() });

        await expect(
            RefreshToken.create({ userId: user._id, tokenHash: hash, expiresAt: new Date() })
        ).rejects.toMatchObject({ code: 11000 });
    });

    it('supports the rotation chain: revoke old, link to new via replacedByTokenId', async function() {
        const oldRecord = await RefreshToken.create({
            userId: user._id,
            tokenHash: RefreshToken.hashToken('old-token'),
            expiresAt: new Date(Date.now() + 1000000),
        });
        const newRecord = await RefreshToken.create({
            userId: user._id,
            tokenHash: RefreshToken.hashToken('new-token'),
            expiresAt: new Date(Date.now() + 1000000),
        });

        oldRecord.revoked = true;
        oldRecord.replacedByTokenId = newRecord._id;
        await oldRecord.save();

        const reloaded = await RefreshToken.findById(oldRecord._id);
        expect(reloaded.revoked).toBe(true);
        expect(reloaded.replacedByTokenId.toString()).toBe(newRecord._id.toString());
    });
});