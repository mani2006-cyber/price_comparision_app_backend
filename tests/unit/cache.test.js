// tests/unit/cache.test.js
//
// Unit tests for src/utils/cache.js. Redis is DISABLED in .env.test
// (REDIS_ENABLED=false, see globalSetup) - which is exactly the
// scenario this file proves is safe: every function must be a silent
// no-op, never throw, when Redis isn't available.

'use strict';

const cache = require('../../src/utils/cache');

describe('cache utils - Redis disabled (as configured in .env.test)', function() {
    it('get() returns null instead of throwing', async function() {
        const result = await cache.get('any-key');
        expect(result).toBeNull();
    });

    it('set() returns false instead of throwing', async function() {
        const result = await cache.set('any-key', { some: 'value' }, 60);
        expect(result).toBe(false);
    });

    it('del() returns false instead of throwing', async function() {
        const result = await cache.del('any-key');
        expect(result).toBe(false);
    });

    it('getOrSet() falls back to calling fetchFn and returns its value', async function() {
        const fetchFn = jest.fn().mockResolvedValue({ fresh: true });

        const result = await cache.getOrSet('any-key', 60, fetchFn);

        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(result.value).toEqual({ fresh: true });
        expect(result.fromCache).toBe(false);
    });
});