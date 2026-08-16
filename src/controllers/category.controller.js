// src/controllers/category.controller.js
//
// HTTP layer over category.service.js. Both routes are public (no auth) -
// browsing a category is the same "look, don't touch" concern as
// GET /products/:id, not a per-user action.

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

module.exports = { listCategories, getCategoryProducts };
