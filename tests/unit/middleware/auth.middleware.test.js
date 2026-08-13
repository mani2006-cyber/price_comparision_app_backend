// tests/unit/middleware/auth.middleware.test.js
//
// Unit tests for auth.middleware.js, focused on requireAuthForStream -
// the header-OR-query-param variant added for the SSE notification
// stream (EventSource can't set custom headers). requireAuth/
// optionalAuth's header-only behavior is already covered by every
// route integration test that hits a protected endpoint; this file
// exists specifically because requireAuthForStream had no coverage
// anywhere else.

'use strict';

const jwt = require('jsonwebtoken');
const config = require('../../../src/config/env');
const { requireAuthForStream } = require('../../../src/middleware/auth.middleware');

function signToken(userId) {
    return jwt.sign({ userId: userId || 'user1' }, config.accessToken.secret, { expiresIn: '15m' });
}

function fakeReq(overrides) {
    return Object.assign({ headers: {}, query: {} }, overrides);
}

describe('requireAuthForStream', function() {
    it('accepts a token via the Authorization header, same as requireAuth', function() {
        const token = signToken('user1');
        const req = fakeReq({ headers: { authorization: 'Bearer ' + token } });
        const next = jest.fn();

        requireAuthForStream(req, {}, next);

        expect(next).toHaveBeenCalledWith(); // no error
        expect(req.userId).toBe('user1');
    });

    it('accepts a token via ?token= query param - the case requireAuth does NOT support', function() {
        const token = signToken('user1');
        const req = fakeReq({ query: { token } });
        const next = jest.fn();

        requireAuthForStream(req, {}, next);

        expect(next).toHaveBeenCalledWith();
        expect(req.userId).toBe('user1');
    });

    it('prefers the header over the query param when both are present', function() {
        const headerToken = signToken('header-user');
        const queryToken = signToken('query-user');
        const req = fakeReq({
            headers: { authorization: 'Bearer ' + headerToken },
            query: { token: queryToken },
        });
        const next = jest.fn();

        requireAuthForStream(req, {}, next);

        expect(req.userId).toBe('header-user');
    });

    it('rejects with 401 when neither header nor query token is present', function() {
        const req = fakeReq();
        const next = jest.fn();

        requireAuthForStream(req, {}, next);

        const err = next.mock.calls[0][0];
        expect(err.statusCode).toBe(401);
    });

    it('rejects a blank ?token= the same as a missing one', function() {
        const req = fakeReq({ query: { token: '   ' } });
        const next = jest.fn();

        requireAuthForStream(req, {}, next);

        expect(next.mock.calls[0][0].statusCode).toBe(401);
    });

    it('rejects an invalid/malformed token with 401', function() {
        const req = fakeReq({ query: { token: 'not-a-real-jwt' } });
        const next = jest.fn();

        requireAuthForStream(req, {}, next);

        expect(next.mock.calls[0][0].statusCode).toBe(401);
    });

    it('rejects an expired token with 401', function() {
        const expiredToken = jwt.sign({ userId: 'user1' }, config.accessToken.secret, { expiresIn: '-1s' });
        const req = fakeReq({ query: { token: expiredToken } });
        const next = jest.fn();

        requireAuthForStream(req, {}, next);

        expect(next.mock.calls[0][0].statusCode).toBe(401);
    });

    it('rejects a token signed with a different secret (e.g. the refresh secret)', function() {
        const wrongToken = jwt.sign({ userId: 'user1' }, config.refreshToken.secret, { expiresIn: '15m' });
        const req = fakeReq({ query: { token: wrongToken } });
        const next = jest.fn();

        requireAuthForStream(req, {}, next);

        expect(next.mock.calls[0][0].statusCode).toBe(401);
    });
});
