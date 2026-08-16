// tests/unit/jobs/priceRefresher.job.test.js
//
// Unit tests for priceRefresher.job.js's own orchestration logic -
// adapters, product.repository.js, alert.service.js, and node-cron are
// all mocked, so this is fast and needs no real DB/network. The
// underlying query logic (which products actually count as "stale AND
// alerted") is covered separately, with a real DB, in
// tests/integration/repositories/product.repository.test.js's
// findStaleWithActiveAlerts block - this file only tests what runOnce()
// DOES with whatever that query returns.

'use strict';

jest.mock('../../../src/adapters');
jest.mock('../../../src/repositories/product.repository');
jest.mock('../../../src/services/alert.service');
jest.mock('node-cron', function() {
    return { schedule: jest.fn() };
});

const cron = require('node-cron');
const config = require('../../../src/config/env');
const adapters = require('../../../src/adapters');
const productRepository = require('../../../src/repositories/product.repository');
const alertService = require('../../../src/services/alert.service');
const priceRefresherJob = require('../../../src/jobs/priceRefresher.job');

function fakeStaleProduct(overrides) {
    return Object.assign({
            _id: 'p1',
            marketplace: 'amazon',
            rawUrl: 'https://www.amazon.in/dp/X1',
            title: 'Test Product',
            lastCheckedAt: new Date('2026-01-01'),
        },
        overrides
    );
}

function fakeProviderProduct(overrides) {
    return Object.assign({ marketplace: 'amazon', externalId: 'X1', title: 'Test Product', currentPrice: 999, rawUrl: 'https://www.amazon.in/dp/X1', fetchedVia: 'api' }, overrides);
}

beforeEach(function() {
    jest.clearAllMocks();
    productRepository.findStaleWithActiveAlerts.mockResolvedValue([]);
});

describe('runOnce', function() {
    it('queries findStaleWithActiveAlerts (NOT findStale) with a 6h-ago threshold and the batch limit', async function() {
        await priceRefresherJob.runOnce();

        expect(productRepository.findStaleWithActiveAlerts).toHaveBeenCalledTimes(1);
        const [threshold, limit] = productRepository.findStaleWithActiveAlerts.mock.calls[0];
        expect(threshold).toBeInstanceOf(Date);
        expect(Date.now() - threshold.getTime()).toBeCloseTo(6 * 60 * 60 * 1000, -3); // within ~1s tolerance
        expect(limit).toBe(100);
        expect(productRepository.findStale).not.toHaveBeenCalled();
    });

    it('re-fetches each stale product via adapters.searchByLink(product.rawUrl)', async function() {
        productRepository.findStaleWithActiveAlerts.mockResolvedValue([fakeStaleProduct()]);
        adapters.searchByLink.mockResolvedValue(fakeProviderProduct());
        productRepository.upsertFromProviderData.mockResolvedValue({
            product: fakeProviderProduct({ _id: 'p1' }),
            priceChanged: false,
        });

        await priceRefresherJob.runOnce();

        expect(adapters.searchByLink).toHaveBeenCalledWith('https://www.amazon.in/dp/X1');
    });

    it('skips a product the adapter could not re-fetch (returns null) without throwing', async function() {
        productRepository.findStaleWithActiveAlerts.mockResolvedValue([fakeStaleProduct()]);
        adapters.searchByLink.mockResolvedValue(null);

        const result = await priceRefresherJob.runOnce();

        expect(productRepository.upsertFromProviderData).not.toHaveBeenCalled();
        expect(result.succeeded).toBe(1); // "handled without error" - a delisted product is not a failure
    });

    it('checks and triggers alerts ONLY when the price actually changed', async function() {
        productRepository.findStaleWithActiveAlerts.mockResolvedValue([fakeStaleProduct()]);
        adapters.searchByLink.mockResolvedValue(fakeProviderProduct({ currentPrice: 799 }));
        productRepository.upsertFromProviderData.mockResolvedValue({
            product: fakeProviderProduct({ _id: 'p1', currentPrice: 799, title: 'Test Product' }),
            priceChanged: true,
        });

        await priceRefresherJob.runOnce();

        expect(alertService.checkAndTriggerAlerts).toHaveBeenCalledWith('p1', 799, 'Test Product');
    });

    it('does NOT check alerts when the price did not change', async function() {
        productRepository.findStaleWithActiveAlerts.mockResolvedValue([fakeStaleProduct()]);
        adapters.searchByLink.mockResolvedValue(fakeProviderProduct());
        productRepository.upsertFromProviderData.mockResolvedValue({
            product: fakeProviderProduct({ _id: 'p1' }),
            priceChanged: false,
        });

        await priceRefresherJob.runOnce();

        expect(alertService.checkAndTriggerAlerts).not.toHaveBeenCalled();
    });

    it('one product failing does not stop the rest of the batch - both succeeded/failed counts are reported', async function() {
        productRepository.findStaleWithActiveAlerts.mockResolvedValue([
            fakeStaleProduct({ _id: 'p1', rawUrl: 'https://www.amazon.in/dp/BAD' }),
            fakeStaleProduct({ _id: 'p2', rawUrl: 'https://www.amazon.in/dp/OK' }),
        ]);
        adapters.searchByLink.mockImplementation(function(url) {
            if (url.indexOf('BAD') !== -1) return Promise.reject(new Error('network error'));
            return Promise.resolve(fakeProviderProduct({ externalId: 'OK' }));
        });
        productRepository.upsertFromProviderData.mockResolvedValue({
            product: fakeProviderProduct({ _id: 'p2' }),
            priceChanged: false,
        });

        const result = await priceRefresherJob.runOnce();

        expect(result.succeeded).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.total).toBe(2);
    });

    it('returns {total: 0, succeeded: 0, failed: 0} when nothing is stale/alerted', async function() {
        const result = await priceRefresherJob.runOnce();
        expect(result).toEqual({ total: 0, succeeded: 0, failed: 0 });
    });
});

describe('start', function() {
    it('registers the configured cron pattern without running anything immediately', function() {
        priceRefresherJob.start();

        expect(cron.schedule).toHaveBeenCalledWith(config.priceRefresher.cronSchedule, expect.any(Function));
        // The whole point: registering the schedule must not itself call
        // runOnce - only the scheduled callback (invoked by node-cron
        // itself, at the next real matching time) does.
        expect(productRepository.findStaleWithActiveAlerts).not.toHaveBeenCalled();
    });

    it('the scheduled callback runs runOnce when node-cron eventually fires it', async function() {
        priceRefresherJob.start();

        const scheduledCallback = cron.schedule.mock.calls[0][1];
        await scheduledCallback();

        expect(productRepository.findStaleWithActiveAlerts).toHaveBeenCalledTimes(1);
    });
});
