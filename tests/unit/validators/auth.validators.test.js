// tests/unit/validators/auth.validators.test.js

'use strict';

const {
    signupBodySchema,
    loginBodySchema,
    passwordResetBodySchema,
} = require('../../../src/validators/auth.validators');

describe('signupBodySchema', function() {
    it('accepts a well-formed signup body', function() {
        const result = signupBodySchema.parse({ name: 'Jane', email: 'jane@example.com', password: 'plaintext123' });
        expect(result).toEqual({ name: 'Jane', email: 'jane@example.com', password: 'plaintext123' });
    });

    it('trims name and email', function() {
        const result = signupBodySchema.parse({ name: '  Jane  ', email: '  jane@example.com  ', password: 'x' });
        expect(result.name).toBe('Jane');
        expect(result.email).toBe('jane@example.com');
    });

    it('does NOT trim password - a leading/trailing space is part of the password', function() {
        const result = signupBodySchema.parse({ name: 'Jane', email: 'jane@example.com', password: '  spaced  ' });
        expect(result.password).toBe('  spaced  ');
    });

    it.each(['name', 'email', 'password'])('rejects a missing "%s" with "Missing or invalid field: %s"', function(field) {
        const body = { name: 'Jane', email: 'jane@example.com', password: 'x' };
        delete body[field];

        expect(function() { signupBodySchema.parse(body); }).toThrow('Missing or invalid field: ' + field);
    });

    it('rejects a malformed email', function() {
        expect(function() {
            signupBodySchema.parse({ name: 'Jane', email: 'not-an-email', password: 'x' });
        }).toThrow('Missing or invalid field: email');
    });
});

describe('loginBodySchema', function() {
    it('accepts a well-formed login body', function() {
        const result = loginBodySchema.parse({ email: 'jane@example.com', password: 'x' });
        expect(result).toEqual({ email: 'jane@example.com', password: 'x' });
    });

    describe('passwordResetBodySchema', function() {
        it('accepts a reset request with a six-digit OTP', function() {
            const result = passwordResetBodySchema.parse({
                email: '  jane@example.com  ',
                otp: '012345',
                password: 'new-password',
            });

            expect(result).toEqual({
                email: 'jane@example.com',
                otp: '012345',
                password: 'new-password',
            });
        });

        it('rejects OTPs that are not exactly six digits', function() {
            expect(function() {
                passwordResetBodySchema.parse({
                    email: 'jane@example.com',
                    otp: '12ab',
                    password: 'new-password',
                });
            }).toThrow('Missing or invalid field: otp');
        });
    });

    it('rejects a missing password', function() {
        expect(function() { loginBodySchema.parse({ email: 'jane@example.com' }); }).toThrow(
            'Missing or invalid field: password'
        );
    });
});
