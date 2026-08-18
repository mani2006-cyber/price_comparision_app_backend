// src/controllers/adminProduct.controller.js
//
// HTTP layer over adminProduct.service.js. Every route sits behind
// adminAuth.middleware.js's requireAdmin (see admin.routes.js), not user
// auth - there's no req.userId here.

'use strict';

const adminProductService = require('../services/adminProduct.service');

async function createProduct(req, res) {
    const product = await adminProductService.createProduct(req.body);
    res.status(201).json({ success: true, product });
}

async function listProducts(req, res) {
    const result = await adminProductService.listProducts({
        category: req.query.category,
        page: req.query.page,
        limit: req.query.limit,
    });
    res.status(200).json({ success: true, result });
}

async function getProduct(req, res) {
    const product = await adminProductService.getProduct(req.params.id);
    res.status(200).json({ success: true, product });
}

async function updateProduct(req, res) {
    const product = await adminProductService.updateProduct(req.params.id, req.body);
    res.status(200).json({ success: true, product });
}

async function deleteProduct(req, res) {
    await adminProductService.deleteProduct(req.params.id);
    res.status(200).json({ success: true, message: 'Catalog product deleted' });
}

module.exports = { createProduct, listProducts, getProduct, updateProduct, deleteProduct };
