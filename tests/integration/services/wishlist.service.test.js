// tests/integration/services/wishlist.service.test.js
//
// Integration test for wishlist.service.js - no adapter mocking needed,
// this service never touches a marketplace. Confirms the reference-not-
// snapshot design, duplicate/not-found translation to ApiError, and
// ownership enforcement (File 43).

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Product = require('../../../src/models/Product.model');
const Wishlist = require('../../../src/models/Wishlist.model');
const wishlistService = require('../../../src/services/wishlist.service');

const EMAIL_A = 'svctest-wishlist-a@example.com';
const EMAIL_B = 'svctest-wishlist-b@example.com';
const MARKETPLACE = 'amazon';
const EXTERNAL_ID = 'WISHSVCTEST_1';

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
        title: 'Wishlist Service Test Product',
        currentPrice: 15000,
        rawUrl: 'https://www.amazon.in/dp/' + EXTERNAL_ID,
        fetchedVia: 'scraper',
    });

    await Wishlist.deleteMany({ userId: { $in: [userA._id, userB._id] } });
});

describe('addToWishlist', function() {
    it('adds a product to the wishlist', async function() {
        const item = await wishlistService.addToWishlist(userA._id, product._id, 'birthday gift');
        expect(item._id).toBeDefined();
        expect(item.notes).toBe('birthday gift');
    });

    it('rejects adding the same product twice with a 409', async function() {
        await wishlistService.addToWishlist(userA._id, product._id);

        await expect(wishlistService.addToWishlist(userA._id, product._id)).rejects.toMatchObject({
            statusCode: 409,
        });
    });

    it('rejects a nonexistent product with a 404', async function() {
        await expect(wishlistService.addToWishlist(userA._id, '000000000000000000000000')).rejects.toMatchObject({
            statusCode: 404,
        });
    });
});

describe('getWishlist', function() {
    it('returns the wishlist with product data populated live', async function() {
        await wishlistService.addToWishlist(userA._id, product._id);

        const items = await wishlistService.getWishlist(userA._id);

        expect(items).toHaveLength(1);
        expect(items[0].productId.title).toBe('Wishlist Service Test Product');
    });

    it('reflects the product\'s CURRENT data, not a snapshot from when it was added', async function() {
        await wishlistService.addToWishlist(userA._id, product._id);
        await Product.updateOne({ _id: product._id }, { currentPrice: 12000 });

        const items = await wishlistService.getWishlist(userA._id);

        expect(items[0].productId.currentPrice).toBe(12000);
    });
});

describe('ownership enforcement', function() {
    it('removeFromWishlist rejects a different user with a 404, leaves the item intact', async function() {
        const item = await wishlistService.addToWishlist(userA._id, product._id);

        await expect(wishlistService.removeFromWishlist(item._id, userB._id)).rejects.toMatchObject({
            statusCode: 404,
        });

        const stillThere = await wishlistService.getWishlist(userA._id);
        expect(stillThere).toHaveLength(1);
    });

    it('removeFromWishlist succeeds for the actual owner', async function() {
        const item = await wishlistService.addToWishlist(userA._id, product._id);

        await wishlistService.removeFromWishlist(item._id, userA._id);

        const afterRemoval = await wishlistService.getWishlist(userA._id);
        expect(afterRemoval).toHaveLength(0);
    });
});
