// src/models/User.model.js
//
// User account: auth credentials + profile. Referenced by Wishlist,
// Alert, SearchHistory, and Notification via userId.

'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config/env');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
    },
    password: {
        type: String,
        required: true,
        select: false, // never returned by default - see file header comment
    },
}, {
    timestamps: true,
});

// ── Hash password on save, only when it's actually changed ─────────────
userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) {
        return next();
    }

    try {
        const salt = await bcrypt.genSalt(config.bcryptSaltRounds);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (err) {
        next(err);
    }
});

// ── Compare a plaintext candidate against the stored hash ──────────────
// NOTE: since `password` has select: false, the document this is called
// on must have been fetched with .select('+password') first, or
// this.password will be undefined and every comparison will fail.
userSchema.methods.comparePassword = async function(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// ── Second layer of defense: strip sensitive/internal fields from any
// JSON response, even if password was somehow loaded onto the document ──
userSchema.set('toJSON', {
    transform: function(doc, ret) {
        delete ret.password;
        delete ret.__v;
        return ret;
    },
});

const User = mongoose.model('User', userSchema);

module.exports = User;