// src/validators/wishlist.validators.js
//
// Zod schema for wishlist.routes.js's POST body. Same message text as
// the old manual check in wishlist.controller.js
// ("A 'productId' is required") so the existing route test keeps
// passing unchanged. productId's actual well-formedness as a Mongo
// ObjectId is still enforced downstream (Mongoose CastError ->
// errorHandler.js's existing 400 branch) - this only checks presence,
// same scope as before.

'use strict';

const { z } = require('zod');

const addWishlistItemBodySchema = z.object({
    productId: z.string("A 'productId' is required").trim().min(1, "A 'productId' is required"),
    notes: z.string().optional(),
});

module.exports = { addWishlistItemBodySchema };
