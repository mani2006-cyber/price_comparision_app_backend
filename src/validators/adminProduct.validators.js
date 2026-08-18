// src/validators/adminProduct.validators.js
//
// Zod schemas for admin.routes.js's request shapes. Same pattern as
// product.validators.js - kept separate from the controller.

'use strict';

const { z } = require('zod');
const { STATUS_VALUES } = require('../models/AdminProduct.model');

// POST /api/admin/products
const createAdminProductBodySchema = z.object({
    title: z.string("A 'title' is required").trim().min(1, "A 'title' is required"),
    description: z.string().trim().min(1).optional(),
    category: z.string("A 'category' is required").trim().min(1, "A 'category' is required"),
    price: z.coerce.number("'price' must be a number").positive("'price' must be a positive number"),
    image: z.string().trim().url("'image' must be a valid URL").optional(),
    // Optional - lets an admin create a draft entry straight into
    // 'hidden' (not yet ready for public category browsing) instead of
    // always publishing immediately and having to PATCH it afterward.
    status: z.enum(STATUS_VALUES).optional(),
});

// PATCH /api/admin/products/:id - every field optional, but at least one
// must be present (an empty body is almost certainly a client mistake,
// not a deliberate no-op update).
const updateAdminProductBodySchema = z.object({
    title: z.string().trim().min(1, "'title' cannot be blank").optional(),
    description: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1, "'category' cannot be blank").optional(),
    price: z.coerce.number("'price' must be a number").positive("'price' must be a positive number").optional(),
    image: z.string().trim().url("'image' must be a valid URL").optional(),
    status: z.enum(STATUS_VALUES).optional(),
}).refine(function(data) { return Object.keys(data).length > 0; }, {
    message: 'At least one field must be provided to update',
});

// GET /api/admin/products - page/limit arrive as query strings, same
// coerce-from-string pattern as every other paginated query schema.
const listAdminProductsQuerySchema = z.object({
    category: z.string().trim().min(1).optional(),
    page: z.coerce.number("'page' must be a number").int().min(1).optional(),
    limit: z.coerce.number("'limit' must be a number").int().min(1).max(100).optional(),
});

module.exports = {
    createAdminProductBodySchema,
    updateAdminProductBodySchema,
    listAdminProductsQuerySchema,
};
