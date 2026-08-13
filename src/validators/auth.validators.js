// src/validators/auth.validators.js
//
// Zod schemas for auth.routes.js's request bodies. Replaces
// auth.controller.js's old requireFields() presence check (kept the
// exact same "Missing or invalid field: <name>" message text so the
// existing route test - tests/integration/routes/auth.routes.test.js's
// "rejects a missing field with a 400" - keeps passing unchanged).
//
// password is deliberately NOT trimmed (unlike name/email) - a
// leading/trailing space is legitimately part of a password; silently
// stripping it would let a user set one password and then be unable to
// log back in with the exact string they typed.

'use strict';

const { z } = require('zod');

const signupBodySchema = z.object({
    name: z.string('Missing or invalid field: name').trim().min(1, 'Missing or invalid field: name'),
    // .email() is a real improvement over the old check (any non-empty
    // string passed before) - not just a presence check, but User.model.js
    // itself already implies this field IS an email (lowercase: true,
    // unique index), so this only rejects input that was always invalid.
    email: z.string('Missing or invalid field: email').trim().min(1, 'Missing or invalid field: email').email('Missing or invalid field: email'),
    password: z.string('Missing or invalid field: password').min(1, 'Missing or invalid field: password'),
});

const loginBodySchema = z.object({
    email: z.string('Missing or invalid field: email').trim().min(1, 'Missing or invalid field: email').email('Missing or invalid field: email'),
    password: z.string('Missing or invalid field: password').min(1, 'Missing or invalid field: password'),
});

module.exports = { signupBodySchema, loginBodySchema };
