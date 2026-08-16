// src/services/aiComparison.service.js
//
// Optional AI-generated natural-language summary for compare.service.js's
// results ("which one's actually the better deal, and why"), on top of
// the existing algorithmic ranking (src/utils/similarity.js) - that
// ranking decides WHICH products are genuine matches, this just narrates
// the already-decided result in plain English. Never a hard dependency:
// if OPENROUTER_API_KEY isn't set, or the request fails/times out/hits
// the free model's rate limit, compareByUrl still returns its normal
// result with aiSummary simply left null - same "degrade gracefully"
// principle as Redis caching elsewhere in this app.
//
// Client creation lives in openRouterClient.js, not here - see that
// file's own comment for why (@openrouter/sdk being ESM-only forces a
// dynamic import(), which isn't mockable by this project's Jest setup
// unless it's isolated behind an ordinary require()).

'use strict';

const config = require('../config/env');
const logger = require('../utils/logger');
const { getClient } = require('./openRouterClient');

// Keeps the prompt small and deterministic - only what the model actually
// needs to compare price/marketplace, never the full Product document
// (images, raw metadata, etc. would just be wasted tokens on a free-tier
// model that likely has a modest context/rate budget).
function buildPrompt(originalProduct, matches) {
    function line(p, isOriginal) {
        return '- ' + (isOriginal ? '[Original] ' : '[Match] ') +
            p.marketplace + ': "' + p.title + '" - ₹' + p.currentPrice;
    }

    const lines = [line(originalProduct, true)].concat(
        matches.map(function(m) { return line(m, false); })
    );

    return (
        'Here is one product found on multiple Indian e-commerce marketplaces:\n\n' +
        lines.join('\n') +
        '\n\nIn 2-3 short sentences, tell the shopper which listing is the better deal ' +
        'and why (price difference, and only mention rating/seller if it materially ' +
        'changes the recommendation). Be direct and concrete - use the actual numbers ' +
        'above, not vague language. Do not use markdown formatting.'
    );
}

// Some models return `content` as a plain string, others as an array of
// content parts ({ type: "text", text: "..." }) - normalize both to a
// single trimmed string.
function extractText(message) {
    if (!message) return null;
    if (typeof message.content === 'string') return message.content.trim() || null;
    if (Array.isArray(message.content)) {
        const text = message.content
            .map(function(part) { return (part && typeof part.text === 'string') ? part.text : ''; })
            .join('')
            .trim();
        return text || null;
    }
    return null;
}

function withTimeout(promise, ms) {
    return new Promise(function(resolve, reject) {
        const timer = setTimeout(function() {
            reject(new Error('OpenRouter request timed out after ' + ms + 'ms'));
        }, ms);
        promise.then(
            function(value) { clearTimeout(timer); resolve(value); },
            function(err) { clearTimeout(timer); reject(err); }
        );
    });
}

// Never throws - a failure here (missing key, network error, free-model
// rate limit, timeout) is always caught and logged, returning null so the
// caller can just do `aiSummary: await generateComparisonSummary(...)`
// without its own try/catch.
async function generateComparisonSummary(originalProduct, matches) {
    if (!config.openRouter.enabled) {
        return null; // no key configured - silently skip, same as Redis being disabled
    }
    if (!matches || matches.length === 0) {
        return null; // nothing to compare against - an AI summary of one product is pointless
    }

    try {
        const client = await getClient();

        const result = await withTimeout(
            client.chat.send({
                chatRequest: {
                    model: config.openRouter.model,
                    messages: [{ role: 'user', content: buildPrompt(originalProduct, matches) }],
                    stream: false,
                    temperature: 0.4,
                    maxTokens: 200,
                },
            }),
            config.openRouter.timeoutMs
        );

        const summary = extractText(result.choices && result.choices[0] && result.choices[0].message);
        if (!summary) {
            logger.warn('OpenRouter returned no usable content for a comparison summary', {
                model: config.openRouter.model,
            });
            return null;
        }

        logger.info('AI comparison summary generated', { model: config.openRouter.model, matchCount: matches.length });
        return summary;
    } catch (err) {
        // Deliberately warn, not error - a down/rate-limited free model is
        // an expected, non-exceptional condition, not an app bug.
        logger.warn('AI comparison summary failed - continuing without it', { message: err.message });
        return null;
    }
}

module.exports = { generateComparisonSummary };
