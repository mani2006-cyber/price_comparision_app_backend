// src/repositories/user.repository.js
//
// All direct Mongoose access for the User collection lives here, and
// ONLY here. Services must never import User.model.js directly - they
// call these functions instead. Repositories return raw documents (or
// null) and contain no business logic - that belongs in the service layer.

'use strict';

const User = require('../models/User.model');

// ── Create ───────────────────────────────────────────────────────────
async function create(userData) {
    return User.create(userData);
}

// ── Reads ────────────────────────────────────────────────────────────

// Standard lookup - password is NEVER included (schema default: select: false).
async function findById(id) {
    return User.findById(id);
}

async function findByEmail(email) {
    return User.findOne({ email: email.toLowerCase() });
}

// The ONLY place in the entire codebase allowed to fetch the password
// hash. Used exclusively by the login flow in auth.service.js.
async function findByEmailWithPassword(email) {
    return User.findOne({ email: email.toLowerCase() }).select('+password');
}

async function existsByEmail(email) {
    const count = await User.countDocuments({ email: email.toLowerCase() });
    return count > 0;
}

// ── Updates ──────────────────────────────────────────────────────────
async function updateById(id, updates) {
    return User.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
}

module.exports = {
    create,
    findById,
    findByEmail,
    findByEmailWithPassword,
    existsByEmail,
    updateById,
};