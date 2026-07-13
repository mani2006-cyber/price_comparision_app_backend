// tests/integration/repositories/wishlist.repository.test.js
//
// Integration test for wishlist.repository.js. The ownership-scoping
// tests here are the security boundary that stops a user from viewing
// or deleting another user's wishlist item by guessing an id (File 18).

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Product = require('../../../src/models/Product.model');
const Wishlist = require('../../../src/models/Wishlist.model');
const wishlistRepository = require('../../../src/repositories/wishlist.repository');

const EMAIL_A = 'repotest-wishlist-a@example.com';
const EMAIL_B = 'repotest-wishlist-b@example.com';
const MARKETPLACE = 'amazon';
const EXTERNAL_ID = 'WISHREPOTEST_1';

let userA;
let userB;
let product;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await User.deleteMany({ email: { $in: [EMAIL_A, EMAIL_B] } });
    await Product.deleteMany({ marketplace: MARKETPLACE, externalId: EXTERNAL_ID });

    userA = await User.create({ name: 'User A', email: EMAIL_A, password: 'plaintext123' });
    userB = await User.create({ name: 'User B', email: EMAIL_B, password: 'plaintext123' });
    product = await Product.create({
        marketplace: MARKETPLACE,
        externalId: EXTERNAL_ID,
        title: 'Wishlist Repo Test Product',
        currentPrice: 7999,
        rawUrl: 'https://www.amazon.in/dp/' + EXTERNAL_ID,
        fetchedVia: 'scraper',
    });

    await Wishlist.deleteMany({ userId: { $in: [userA._id, userB._id] } });
});

describe('wishlist.repository', function() {
    it('addItem + findByUser returns populated product data', async function() {
        await wishlistRepository.addItem(userA._id, product._id, 'for testing');

        const list = await wishlistRepository.findByUser(userA._id);
        expect(list).toHaveLength(1);
        expect(list[0].productId.title).toBe('Wishlist Repo Test Product');
    });

    it('findByUserAndProduct finds an existing entry for duplicate-checking', async function() {
        await wishlistRepository.addItem(userA._id, product._id);

        const found = await wishlistRepository.findByUserAndProduct(userA._id, product._id);
        expect(found).not.toBeNull();
    });

    describe('ownership scoping', function() {
        it('findByIdForUser returns null when the item belongs to a different user', async function() {
            const item = await wishlistRepository.addItem(userA._id, product._id);

            const result = await wishlistRepository.findByIdForUser(item._id, userB._id);
            expect(result).toBeNull();
        });

        it('findByIdForUser returns the item for its actual owner', async function() {
            const item = await wishlistRepository.addItem(userA._id, product._id);

            const result = await wishlistRepository.findByIdForUser(item._id, userA._id);
            expect(result).not.toBeNull();
        });

        it('removeByIdForUser does NOT delete an item belonging to a different user', async function() {
            const item = await wishlistRepository.addItem(userA._id, product._id);

            const result = await wishlistRepository.removeByIdForUser(item._id, userB._id);
            expect(result.deletedCount).toBe(0);

            const stillExists = await wishlistRepository.findByIdForUser(item._id, userA._id);
            expect(stillExists).not.toBeNull();
        });

        it('removeByIdForUser DOES delete when called by the actual owner', async function() {
            const item = await wishlistRepository.addItem(userA._id, product._id);

            const result = await wishlistRepository.removeByIdForUser(item._id, userA._id);
            expect(result.deletedCount).toBe(1);
        });
    });
});