// src/routes/admin.routes.js
//
// Admin CRUD over the curated catalog (AdminProduct) - every route below
// requires the x-admin-key header (adminAuth.middleware.js's
// requireAdmin), not user auth. This is the WRITE side; the public read
// side (GET /api/categories, GET /api/categories/:category/products) is
// unauthenticated and lives in category.routes.js.

'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAdmin } = require('../middleware/adminAuth.middleware');
const validate = require('../middleware/validate.middleware');
const {
    createAdminProductBodySchema,
    updateAdminProductBodySchema,
    listAdminProductsQuerySchema,
} = require('../validators/adminProduct.validators');
const adminProductController = require('../controllers/adminProduct.controller');

const router = express.Router();

router.use(requireAdmin);

router.post('/', validate({ body: createAdminProductBodySchema }), asyncHandler(adminProductController.createProduct));
router.get('/', validate({ query: listAdminProductsQuerySchema }), asyncHandler(adminProductController.listProducts));
router.get('/:id', asyncHandler(adminProductController.getProduct));
router.patch('/:id', validate({ body: updateAdminProductBodySchema }), asyncHandler(adminProductController.updateProduct));
router.delete('/:id', asyncHandler(adminProductController.deleteProduct));

module.exports = router;
