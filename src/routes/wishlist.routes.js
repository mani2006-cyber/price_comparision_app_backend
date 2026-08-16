// src/routes/wishlist.routes.js
//
// All wishlist endpoints require authentication - no optionalAuth here,
// unlike product.routes.js's /search: POST/GET /api/wishlist,
// DELETE /api/wishlist/:id.

'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { addWishlistItemBodySchema } = require('../validators/wishlist.validators');
const wishlistController = require('../controllers/wishlist.controller');

const router = express.Router();

router.use(requireAuth); // applies to every route below - entire file requires auth

router.post('/', validate({ body: addWishlistItemBodySchema }), asyncHandler(wishlistController.addItem));
router.get('/', asyncHandler(wishlistController.getWishlist));
router.delete('/:id', asyncHandler(wishlistController.removeItem));

module.exports = router;