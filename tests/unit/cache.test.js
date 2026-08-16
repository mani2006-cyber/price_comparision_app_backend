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

// The in-flight de-duplication map is a plain in-process Map, entirely
// independent of Redis - so this is testable even with Redis disabled
// (as .env.test has it). Confirmed live: two near-simultaneous
// compare-url requests for the same key both missed the cache (neither
// had finished writing yet) and both ran the full expensive fetch
// independently - this is the fix for that.
describe('getOrSet() - in-flight request coalescing', function() {
    it('calls fetchFn only ONCE for two concurrent calls with the same key', async function() {
        let resolveFetch;
        const fetchFn = jest.fn(function() {
            return new Promise(function(resolve) { resolveFetch = resolve; });
        });

        const call1 = cache.getOrSet('concurrent-key', 60, fetchFn);
        const call2 = cache.getOrSet('concurrent-key', 60, fetchFn);

        // Let both calls' initial cache.get() checks resolve and reach
        // the in-flight map before releasing the shared fetch.
        await new Promise(function(resolve) { setImmediate(resolve); });
        resolveFetch({ shared: true });

        const [result1, result2] = await Promise.all([call1, call2]);

        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(result1.value).toEqual({ shared: true });
        expect(result2.value).toEqual({ shared: true });
    });

    it('a coalesced follower rejects too, if the shared fetch fails', async function() {
        let rejectFetch;
        const fetchFn = jest.fn(function() {
            return new Promise(function(_, reject) { rejectFetch = reject; });
        });

        const call1 = cache.getOrSet('concurrent-fail-key', 60, fetchFn);
        const call2 = cache.getOrSet('concurrent-fail-key', 60, fetchFn);

        await new Promise(function(resolve) { setImmediate(resolve); });
        rejectFetch(new Error('upstream failed'));

        await expect(call1).rejects.toThrow('upstream failed');
        await expect(call2).rejects.toThrow('upstream failed');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('does NOT coalesce two calls with DIFFERENT keys', async function() {
        const fetchFn = jest.fn()
            .mockResolvedValueOnce({ a: 1 })
            .mockResolvedValueOnce({ b: 2 });

        const [result1, result2] = await Promise.all([
            cache.getOrSet('key-a', 60, fetchFn),
            cache.getOrSet('key-b', 60, fetchFn),
        ]);

        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(result1.value).toEqual({ a: 1 });
        expect(result2.value).toEqual({ b: 2 });
    });

    it('a SUBSEQUENT (non-concurrent) call for the same key runs its own fresh fetch, not a stale coalesced one', async function() {
        const fetchFn = jest.fn()
            .mockResolvedValueOnce({ first: true })
            .mockResolvedValueOnce({ second: true });

        const first = await cache.getOrSet('sequential-key', 60, fetchFn);
        const second = await cache.getOrSet('sequential-key', 60, fetchFn);

        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(first.value).toEqual({ first: true });
        expect(second.value).toEqual({ second: true });
    });
});