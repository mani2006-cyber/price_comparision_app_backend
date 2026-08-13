// tests/integration/models/User.test.js
//
// Integration test - touches the real (test) MongoDB via .env.test.
// Converts the manual script from File 9 into permanent assertions,
// including the two security-relevant checks: password is never
// returned by a plain find, and toJSON strips it even when explicitly
// selected.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');

const TEST_EMAIL = 'modeltest-user@example.com';

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await User.deleteMany({ email: TEST_EMAIL });
});

describe('User model', function() {
    it('hashes the password automatically on create', async function() {
        const user = await User.create({
            name: 'Model Test',
            email: TEST_EMAIL,
            password: 'plaintext123',
        });

        expect(user._id).toBeDefined();

        const withPassword = await User.findOne({ email: TEST_EMAIL }).select('+password');
        expect(withPassword.password).not.toBe('plaintext123');
        expect(withPassword.password).toMatch(/^\$2[aby]\$/); // bcrypt hash prefix
    });

    it('does NOT return the password field on a normal find (select: false)', async function() {
        await User.create({ name: 'Model Test', email: TEST_EMAIL, password: 'plaintext123' });

        const found = await User.findOne({ email: TEST_EMAIL });
        expect(found.password).toBeUndefined();
    });

    it('returns the password field only when explicitly selected', async function() {
        await User.create({ name: 'Model Test', email: TEST_EMAIL, password: 'plaintext123' });

        const withPassword = await User.findOne({ email: TEST_EMAIL }).select('+password');
        expect(withPassword.password).toBeDefined();
    });

    it('comparePassword correctly matches the right password and rejects the wrong one', async function() {
        await User.create({ name: 'Model Test', email: TEST_EMAIL, password: 'plaintext123' });

        const withPassword = await User.findOne({ email: TEST_EMAIL }).select('+password');

        expect(await withPassword.comparePassword('plaintext123')).toBe(true);
        expect(await withPassword.comparePassword('wrongpassword')).toBe(false);
    });

    it('toJSON strips password and __v even when password was explicitly selected', async function() {
        await User.create({ name: 'Model Test', email: TEST_EMAIL, password: 'plaintext123' });

        const withPassword = await User.findOne({ email: TEST_EMAIL }).select('+password');
        const serialized = JSON.parse(JSON.stringify(withPassword));

        expect(serialized.password).toBeUndefined();
        expect(serialized.__v).toBeUndefined();
        expect(serialized.email).toBe(TEST_EMAIL);
    });

    it('rejects a duplicate email via the unique index', async function() {
        await User.create({ name: 'First', email: TEST_EMAIL, password: 'plaintext123' });

        await expect(
            User.create({ name: 'Duplicate', email: TEST_EMAIL, password: 'whatever123' })
        ).rejects.toMatchObject({ code: 11000 });
    });

    it('only re-hashes the password when it is actually modified', async function() {
        const user = await User.create({ name: 'Model Test', email: TEST_EMAIL, password: 'plaintext123' });
        const withPassword = await User.findOne({ email: TEST_EMAIL }).select('+password');
        const originalHash = withPassword.password;

        withPassword.name = 'Updated Name';
        await withPassword.save();

        const afterUpdate = await User.findOne({ email: TEST_EMAIL }).select('+password');
        expect(afterUpdate.password).toBe(originalHash); // unchanged - name changed, not password
    });
});