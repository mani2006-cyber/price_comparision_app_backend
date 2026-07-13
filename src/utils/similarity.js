// src/utils/similarity.js
//
// Pure function: scores how similar two product titles are, from 0 (no
// overlap) to 1 (identical word sets). Used to find the "closest match"
// for a product on a different marketplace, where titles are rarely
// worded identically (e.g. "Apple iPhone 16e 128GB" vs "iPhone 16e
// (128 GB) - Black"), so exact string matching would almost never work.
//
// Approach: treat each title as a "bag of words" (a Set) and measure
// overlap using the Jaccard index - intersection size divided by union
// size. Better suited to product titles than character-based algorithms
// like Levenshtein distance, which care about exact letter positions -
// not useful when word ORDER differs between sites.

'use strict';

// Common words that appear in almost every product title and add no
// real signal about WHICH product it is - excluding them improves
// matching accuracy.
const STOPWORDS = new Set(['with', 'and', 'for', 'the', 'in', 'of', 'a', 'to', 'on']);

function tokenize(title) {
    return String(title)
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ') // strip punctuation: commas, parens, colons, etc.
        .split(/\s+/)
        .filter(function(word) {
            return word.length > 1 && !STOPWORDS.has(word);
        });
}

function calculateSimilarity(titleA, titleB) {
    const wordsA = new Set(tokenize(titleA));
    const wordsB = new Set(tokenize(titleB));

    if (wordsA.size === 0 || wordsB.size === 0) {
        return 0;
    }

    let intersectionSize = 0;
    wordsA.forEach(function(word) {
        if (wordsB.has(word)) intersectionSize++;
    });

    const unionSize = wordsA.size + wordsB.size - intersectionSize;
    return intersectionSize / unionSize; // Jaccard index, 0 to 1
}

// Given one product title and a list of candidates (each with a .title
// field), returns the candidates sorted by similarity score, most
// similar first, each annotated with its score.
function rankBySimilarity(originalTitle, candidates) {
    return candidates
        .map(function(candidate) {
            return Object.assign({}, candidate.toObject ? candidate.toObject() : candidate, {
                similarityScore: calculateSimilarity(originalTitle, candidate.title),
            });
        })
        .sort(function(a, b) {
            return b.similarityScore - a.similarityScore;
        });
}

// ── Spec extraction & combined scoring ──────────────────────────────
//
// Title similarity alone can't distinguish "same product, different
// retailer" from "closely related product, same or different retailer"
// - an iPhone 16e and iPhone 17e share almost every word except the
// model number. These functions add two more signals: does the storage
// capacity match (a hard product-identity signal), and is the price in
// a plausible range for genuinely the same item (same product rarely
// differs more than ~15-20% across retailers - see productMatcher
// weighting below).

function extractStorageGB(title) {
    const match = String(title).match(/(\d+)\s*(GB|TB)\b/i);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    return match[2].toUpperCase() === 'TB' ? value * 1024 : value;
}

function specMatchScore(titleA, titleB) {
    const storageA = extractStorageGB(titleA);
    const storageB = extractStorageGB(titleB);

    // If NEITHER title has an extractable spec, don't penalize - this
    // signal simply doesn't apply to this product category (e.g. clothing).
    if (storageA === null && storageB === null) return 1;

    // If only one side has an extractable spec, it's inconclusive rather
    // than a hard mismatch - treat as neutral, not a penalty.
    if (storageA === null || storageB === null) return 0.5;

    return storageA === storageB ? 1 : 0;
}

// 1.0 at identical price, decaying to 0 by the time prices differ by
// more than ~60% - genuinely the same product across retailers rarely
// differs beyond ~20%, so this comfortably tolerates real-world price
// variation while still penalizing "different product" price gaps.
// A candidate priced less than 40% or more than 250% of the original is
// almost certainly a DIFFERENT product (an accessory, a different
// model tier, a bundle) - no realistic amount of title overlap should
// override that. This is a HARD gate, not a soft weighted signal - the
// previous version scored price at only 15% weight, which let generic
// shared words ("Apple", "Camera") in an accessory's title outvote an
// enormous, obvious price mismatch. Gate first, THEN score what passes.
const MIN_PRICE_RATIO = 0.4;
const MAX_PRICE_RATIO = 2.5;

function passesPriceGate(priceA, priceB) {
    if (!priceA || !priceB || priceA <= 0 || priceB <= 0) return true; // can't evaluate - don't block on missing data
    const ratio = priceB / priceA;
    return ratio >= MIN_PRICE_RATIO && ratio <= MAX_PRICE_RATIO;
}

// Soft score WITHIN the gated range - still rewards being closer in
// price, just no longer the only thing standing between an accessory
// and a "match".
function priceProximityScore(priceA, priceB) {
    if (!priceA || !priceB || priceA <= 0 || priceB <= 0) return 0.5;
    const ratio = Math.abs(priceA - priceB) / Math.max(priceA, priceB);
    return Math.max(0, 1 - ratio / 0.6);
}

// Below this, two titles share too little real vocabulary to be
// plausibly the same product - e.g. an iPhone listing and a camera
// listing sharing only the generic word "camera" scores ~0.04 here.
// Without this gate, a low-but-nonzero title score could still be
// rescued by a NEUTRAL (0.5) spec score plus so-so price proximity,
// which is exactly what let the Fujifilm camera through last run.
const MIN_TITLE_SIMILARITY = 0.12;

function combinedMatchScore(original, candidate) {
    if (!passesPriceGate(original.currentPrice, candidate.currentPrice)) {
        return 0;
    }

    const titleScore = calculateSimilarity(original.title, candidate.title);
    if (titleScore < MIN_TITLE_SIMILARITY) {
        return 0;
    }

    const specScore = specMatchScore(original.title, candidate.title);
    const priceScore = priceProximityScore(original.currentPrice, candidate.currentPrice);

    return (titleScore * 0.55) + (specScore * 0.30) + (priceScore * 0.15);
}
// Same shape as rankBySimilarity, but scores using combinedMatchScore
// against a full original product object (needs .title AND
// .currentPrice), not just a title string.
function rankByCombinedMatch(originalProduct, candidates) {
    return candidates
        .map(function(candidate) {
            const plain = candidate.toObject ? candidate.toObject() : candidate;
            return Object.assign({}, plain, {
                similarityScore: combinedMatchScore(originalProduct, plain),
            });
        })
        .sort(function(a, b) { return b.similarityScore - a.similarityScore; });
}

module.exports = {
    calculateSimilarity,
    rankBySimilarity,
    tokenize,
    extractStorageGB,
    specMatchScore,
    passesPriceGate,
    priceProximityScore,
    combinedMatchScore,
    rankByCombinedMatch,
};