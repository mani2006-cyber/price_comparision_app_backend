// src/controllers/category.controller.js
//
// HTTP layer over category.service.js. All three routes are public (no
// auth) - browsing the catalog and clicking through to live listings are
// both "look, don't touch" concerns, same as GET /products/:id.

'use strict';

const categoryService = require('../services/category.service');

async function listCategories(req, res) {
    const categories = await categoryService.listCategories();
    res.status(200).json({ success: true, count: categories.length, categories });
}

async function getCategoryProducts(req, res) {
    const result = await categoryService.getProductsByCategory(req.params.category, {
        sortBy: req.query.sortBy,
        page: req.query.page,
        limit: req.query.limit,
    });
    res.status(200).json({ success: true, result });
}

async function getProductListings(req, res) {
    const result = await categoryService.getProductListings(req.params.id, {
        sortBy: req.query.sortBy,
        page: req.query.page,
        limit: req.query.limit,
    });
    res.status(200).json({ success: true, result });
}

module.exports = { listCategories, getCategoryProducts, getProductListings };
