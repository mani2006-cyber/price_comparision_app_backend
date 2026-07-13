// tests/unit/similarity.test.js
//
// Pure unit tests for src/utils/similarity.js - no database, no Express,
// no network. Covers both the original Jaccard-similarity behavior
// (File 45) and the hard-gate fixes added during the compare-algorithm
// debugging session, so those bugs (e.g. an accessory or unrelated
// product matching a phone) can never silently regress.

'use strict';

const {
    calculateSimilarity,
    rankBySimilarity,
    tokenize,
    extractStorageGB,
    specMatchScore,
    passesPriceGate,
    priceProximityScore,
    combinedMatchScore,
    rankByCombinedMatch,
} = require('../../src/utils/similarity');

describe('tokenize', function() {
    it('lowercases and strips punctuation', function() {
        expect(tokenize('Apple iPhone 16e, 128GB!')).toEqual(
            expect.arrayContaining(['apple', 'iphone', '16e', '128gb'])
        );
    });

    it('removes stopwords', function() {
        expect(tokenize('phone with case and screen protector')).not.toContain('with');
        expect(tokenize('phone with case and screen protector')).not.toContain('and');
    });

    it('drops single-character tokens', function() {
        expect(tokenize('a phone')).not.toContain('a');
    });
});

describe('calculateSimilarity', function() {
    it('scores identical titles as 1', function() {
        expect(calculateSimilarity('Apple iPhone 16e 128GB', 'Apple iPhone 16e 128GB')).toBe(1);
    });

    it('scores the same product with different wording as meaningfully high', function() {
        const score = calculateSimilarity(
            'Apple iPhone 16e 128 GB: Built for Apple Intelligence, A18 Chip',
            'iPhone 16e (128 GB) - Black, A18 Chip, Apple Intelligence'
        );
        expect(score).toBeGreaterThan(0.3);
    });

    it('scores unrelated titles near zero', function() {
        const score = calculateSimilarity('Apple iPhone 16e 128GB', 'Nike Running Shoes Size 10');
        expect(score).toBeLessThan(0.1);
    });

    it('returns 0 for an empty title, without throwing', function() {
        expect(calculateSimilarity('', 'Apple iPhone 16e')).toBe(0);
    });

    it('scores minimal generic-word overlap as very low - the Fujifilm/iPhone regression case', function() {
        // Real case hit during compare-service debugging: an iPhone listing
        // and a camera listing shared only the word "camera".
        const score = calculateSimilarity(
            'Apple iPhone 16e 128 GB: 48MP Fusion Camera',
            'FUJIFILM Instax Mini Instant Camera'
        );
        expect(score).toBeLessThan(0.12); // below combinedMatchScore's MIN_TITLE_SIMILARITY gate
    });
});

describe('rankBySimilarity', function() {
    it('sorts candidates most-similar first', function() {
        const ranked = rankBySimilarity('Apple iPhone 16e 128GB Black', [
            { title: 'Samsung Galaxy S24' },
            { title: 'Apple iPhone 16e 128 GB Black' },
            { title: 'Apple iPhone 15 128GB Blue' },
        ]);
        expect(ranked[0].title).toBe('Apple iPhone 16e 128 GB Black');
        expect(ranked[2].title).toBe('Samsung Galaxy S24');
    });

    it('annotates each candidate with a similarityScore', function() {
        const ranked = rankBySimilarity('test title', [{ title: 'test title' }]);
        expect(ranked[0].similarityScore).toBe(1);
    });
});

describe('extractStorageGB', function() {
    it('extracts GB values', function() {
        expect(extractStorageGB('Apple iPhone 16e 128GB Black')).toBe(128);
    });

    it('converts TB to GB', function() {
        expect(extractStorageGB('Laptop with 1TB SSD')).toBe(1024);
    });

    it('returns null when no storage spec is present', function() {
        expect(extractStorageGB('Nike Running Shoes Size 10')).toBeNull();
    });
});

describe('specMatchScore', function() {
    it('scores matching storage as 1', function() {
        expect(specMatchScore('Phone 128GB Black', 'Phone 128 GB White')).toBe(1);
    });

    it('scores mismatched storage as 0', function() {
        expect(specMatchScore('Phone 128GB Black', 'Phone 256GB Black')).toBe(0);
    });

    it('scores neutral (0.5) when only one side has an extractable spec', function() {
        expect(specMatchScore('Phone 128GB Black', 'Phone Black')).toBe(0.5);
    });

    it('scores neutral (1) when neither side has a spec - does not apply to this category', function() {
        expect(specMatchScore('Nike Shoes', 'Adidas Shoes')).toBe(1);
    });
});

describe('passesPriceGate', function() {
    it('passes for prices within a plausible range', function() {
        expect(passesPriceGate(59900, 67900)).toBe(true); // the real iPhone 16/16e case from testing
    });

    it('rejects a price far below the original - the accessory regression case', function() {
        // Real case hit during debugging: a ₹122 camera lens protector
        // matched a ₹59,900 phone on title overlap alone before this gate existed.
        expect(passesPriceGate(59900, 122)).toBe(false);
    });

    it('rejects a price far above the original', function() {
        expect(passesPriceGate(10000, 500000)).toBe(false);
    });

    it('does not block when price data is missing (inconclusive, not disqualifying)', function() {
        expect(passesPriceGate(null, 1000)).toBe(true);
        expect(passesPriceGate(1000, undefined)).toBe(true);
    });
});

describe('priceProximityScore', function() {
    it('scores identical prices as 1', function() {
        expect(priceProximityScore(1000, 1000)).toBe(1);
    });

    it('scores closer prices higher than farther ones', function() {
        const close = priceProximityScore(1000, 1050);
        const far = priceProximityScore(1000, 1400);
        expect(close).toBeGreaterThan(far);
    });
});

describe('combinedMatchScore', function() {
    const original = { title: 'Apple iPhone 16e 128 GB Black', currentPrice: 59900 };

    it('scores a genuine cross-marketplace match as meaningfully positive', function() {
        const candidate = { title: 'Apple iPhone 16 128 GB Black', currentPrice: 67900 };
        expect(combinedMatchScore(original, candidate)).toBeGreaterThan(0.2);
    });

    it('returns exactly 0 for a price-gate failure regardless of title overlap - accessory regression', function() {
        const accessory = { title: 'Apple iPhone Camera Lens Protector', currentPrice: 122 };
        expect(combinedMatchScore(original, accessory)).toBe(0);
    });

    it('returns exactly 0 for a title-similarity-gate failure - Fujifilm regression', function() {
        const unrelated = { title: 'FUJIFILM Instax Mini Instant Camera', currentPrice: 37498 };
        expect(combinedMatchScore(original, unrelated)).toBe(0);
    });

    it('penalizes a spec mismatch (different storage) even with decent title overlap', function() {
        const sameModelDifferentStorage = { title: 'Apple iPhone 16e 256 GB Black', currentPrice: 65900 };
        const sameStorage = { title: 'Apple iPhone 16e 128 GB Black', currentPrice: 59900 };
        // identical candidate (storage matches) should score higher than
        // the mismatched-storage one, all else being similar
        expect(combinedMatchScore(original, sameStorage)).toBeGreaterThan(
            combinedMatchScore(original, sameModelDifferentStorage)
        );
    });
});

describe('rankByCombinedMatch', function() {
    it('filters out non-matches and ranks real matches by score', function() {
        const original = { title: 'Apple iPhone 16e 128 GB Black', currentPrice: 59900 };
        const candidates = [
            { marketplace: 'flipkart', title: 'Apple iPhone 16 128 GB Black', currentPrice: 67900 },
            { marketplace: 'myntra', title: 'FUJIFILM Instax Mini Instant Camera', currentPrice: 37498 },
            { marketplace: 'flipkart', title: 'Apple iPhone Camera Lens Protector', currentPrice: 122 },
        ];

        const ranked = rankByCombinedMatch(original, candidates);

        expect(ranked[0].title).toBe('Apple iPhone 16 128 GB Black');
        expect(ranked[0].similarityScore).toBeGreaterThan(0);
        // the unrelated camera and the accessory should both score exactly 0
        expect(ranked[1].similarityScore).toBe(0);
        expect(ranked[2].similarityScore).toBe(0);
    });
});