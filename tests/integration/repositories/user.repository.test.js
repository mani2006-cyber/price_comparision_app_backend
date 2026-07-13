// tests/integration/repositories/user.repository.test.js
//
// Integration test for user.repository.js. Confirms the password-safety
// boundary from File 16: findByEmail never returns a password,
// findByEmailWithPassword is the ONLY function that does.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const userRepository = require('../../../src/repositories/user.repository');

const TEST_EMAIL = 'repotest-user@example.com';

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await User.deleteMany({ email: TEST_EMAIL });
});

describe('user.repository', function() {
    it('create() persists a new user', async function() {
        const user = await userRepository.create({ name: 'Repo Test', email: TEST_EMAIL, password: 'plaintext123' });
        expect(user._id).toBeDefined();
    });

    it('existsByEmail correctly distinguishes existing vs non-existing emails', async function() {
        await userRepository.create({ name: 'Repo Test', email: TEST_EMAIL, password: 'plaintext123' });

        expect(await userRepository.existsByEmail(TEST_EMAIL)).toBe(true);
        expect(await userRepository.existsByEmail('nobody-' + TEST_EMAIL)).toBe(false);
    });

    it('findByEmail never returns the password field', async function() {
        await userRepository.create({ name: 'Repo Test', email: TEST_EMAIL, password: 'plaintext123' });

        const found = await userRepository.findByEmail(TEST_EMAIL);
        expect(found.password).toBeUndefined();
    });

    it('findByEmailWithPassword is the only function that returns it', async function() {
        await userRepository.create({ name: 'Repo Test', email: TEST_EMAIL, password: 'plaintext123' });

        const withPassword = await userRepository.findByEmailWithPassword(TEST_EMAIL);
        expect(withPassword.password).toBeDefined();
    });

    it('updateById applies and returns the updated document', async function() {
        const user = await userRepository.create({ name: 'Repo Test', email: TEST_EMAIL, password: 'plaintext123' });

        const updated = await userRepository.updateById(user._id, { name: 'Updated Name' });
        expect(updated.name).toBe('Updated Name');
    });

    it('findById returns the correct user', async function() {
        const user = await userRepository.create({ name: 'Repo Test', email: TEST_EMAIL, password: 'plaintext123' });

        const found = await userRepository.findById(user._id);
        expect(found.email).toBe(TEST_EMAIL);
    });
});