// src/services/aiCategory.service.js
//
// Optional LLM-based category classifier, same pattern as
// aiComparison.service.js: never a hard dependency. If OPENROUTER_API_KEY
// isn't set, or a request fails / times out / hits the free model's rate
// limit, the affected products are simply left out of the result and the
// caller keeps whatever category its own logic (store breadcrumb mapping,
// keyword rules, trained classifier) already assigned.
//
// Meant to be used as a FALLBACK: send only products your own logic could
// not classify confidently, not the whole catalog.
//
// Returns an object keyed by product id:
//   { "<id>": { id, category, isAccessory, confidence, source } }
//   - category is one of CATEGORIES, or 'unknown'
//   - source is 'llm' or 'cache'
//   - an id that is missing from the result was NOT classified
//     (disabled, failed, or invalid output after one retry)

'use strict';

const config = require('../config/env');
const logger = require('../utils/logger');

// REPLACE with your real category list. The model may only answer with
// these exact names (anything else is rejected and retried once).
const CATEGORIES = [
    'Mobiles',
    'Laptops',
    'Earbuds & Headphones',
    'Smartwatches',
    'TVs',
    'Home Appliances',
    'Home & Kitchen',
    'Clothing',
    'Shoes',
    'Eyewear',
    'Beauty & Personal Care',
    'Books',
    'Toys',
    'Sports & Outdoors',
    'Automotive',
];

const UNKNOWN = 'unknown';
const MAX_DESCRIPTION_CHARS = 250;
const MAX_TITLE_CHARS = 200;
const CACHE_LIMIT = 5000;

// lowercase name -> canonical name, for forgiving case/spacing differences
const CATEGORY_LOOKUP = {};
CATEGORIES.forEach(function(name) {
    CATEGORY_LOOKUP[name.toLowerCase()] = name;
});

// In-memory cache keyed by normalized title + brand, so the same product is
// never sent twice. Swap for your Redis helper if you want it shared
// across processes.
const cache = new Map();

// Read lazily so tests can change config between calls. All keys are
// optional - the fallbacks below apply if you haven't added them to
// config/env.js.
function getSettings() {
    const c = config.gemini || {};
    return {
        batchSize: c.classifyBatchSize || 5,
        maxTokens: c.classifyMaxTokens || 1000,
        timeoutMs: c.timeoutMs || 30000,
        retryCount: c.retryCount || 2,
        retryDelayMs: c.retryDelayMs || 1500,
    };
}

function cleanText(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function cacheKey(product) {
    return (cleanText(product.title, MAX_TITLE_CHARS) + '|' + cleanText(product.brand, 60)).toLowerCase();
}

function remember(product, result) {
    if (cache.size >= CACHE_LIMIT) {
        cache.delete(cache.keys().next().value); // drop the oldest entry
    }
    cache.set(cacheKey(product), {
        category: result.category,
        isAccessory: result.isAccessory,
        confidence: result.confidence,
    });
}

// Fixed rules live in the system message; only the products change per call.
function buildMessages(batch) {
    const system =
        'You classify Indian e-commerce products into a fixed category list.\n' +
        'Allowed categories (use the exact spelling): ' + CATEGORIES.join(' | ') + '\n\n' +
        'Rules:\n' +
        '- Pick exactly one category per product.\n' +
        '- If the product is an accessory for another product (case, cover, charger, strap, screen guard), ' +
        'give the category of the main product it is made for and set is_accessory to true.\n' +
        '- If a store breadcrumb is given, treat it as a strong hint.\n' +
        '- A store category may also be given as a hint, but never return it unless it is in the allowed list.\n' +
        '- If no category fits, use "' + UNKNOWN + '".\n' +
        '- confidence is a number from 0 to 1.\n\n' +
        'Return ONLY a JSON array, no markdown and no extra text, with one object per input product ' +
        'and the same id: [{"id":"...","category":"...","is_accessory":false,"confidence":0.9}]\n\n' +
        'Examples:\n' +
        '- "boAt Airdopes 141 Bluetooth TWS Earbuds" -> Earbuds & Headphones, is_accessory false\n' +
        '- "Silicone case for AirPods Pro" -> Earbuds & Headphones, is_accessory true\n' +
        '- "Ray-Ban Aviator Sunglasses" -> Eyewear, is_accessory false';

    const payload = batch.map(function(p) {
        return {
            id: String(p.id),
            title: cleanText(p.title, MAX_TITLE_CHARS),
            brand: cleanText(p.brand, 60),
            storeCategory: cleanText(p.category, 120),
            breadcrumb: cleanText(p.breadcrumb, 120),
            description: cleanText(p.description, MAX_DESCRIPTION_CHARS),
        };
    });

    return [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
    ];
}

// Same normalization as aiComparison.service.js: some models return
// `content` as a string, others as an array of { type: "text", text } parts.
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

function isRetryableGeminiError(err) {
    return /status (429|500|502|503|504)/.test(err.message || '');
}

function wait(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// Tolerates ```json fences and text around the array.
function parseJsonArray(text) {
    if (!text) return null;
    const cleaned = text.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return null;
    try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
        return null;
    }
}

// Returns a validated result, or null if the item is unusable
// (missing id, or a category that is not in CATEGORIES).
function normalizeItem(item) {
    if (!item || item.id === undefined || item.id === null) return null;

    const rawCategory = String(item.category === undefined || item.category === null ? '' : item.category)
        .trim()
        .toLowerCase();

    let category;
    if (rawCategory === UNKNOWN) {
        category = UNKNOWN; // a legitimate answer - no point retrying it
    } else if (CATEGORY_LOOKUP[rawCategory]) {
        category = CATEGORY_LOOKUP[rawCategory];
    } else {
        return null; // invented or misspelled category
    }

    let confidence = Number(item.confidence);
    if (!isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));

    return {
        id: String(item.id),
        category: category,
        isAccessory: item.is_accessory === true,
        confidence: category === UNKNOWN ? 0 : confidence,
        source: 'llm',
    };
}

// One API call. Throws on network error / timeout (the caller handles it).
// Returns the validated results plus the ids that came back invalid or missing.
async function classifyBatch(batch, settings) {
    const messages = buildMessages(batch);

    let result;
    for (let attempt = 0; attempt <= settings.retryCount; attempt++) {
        try {
            result = await withTimeout(
                fetch(
                    'https://generativelanguage.googleapis.com/v1beta/models/' +
                    encodeURIComponent(config.gemini.model) + ':generateContent',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-goog-api-key': config.gemini.apiKey,
                        },
                        body: JSON.stringify({
                            systemInstruction: { parts: [{ text: messages[0].content }] },
                            contents: [{ parts: [{ text: messages[1].content }] }],
                            generationConfig: {
                                temperature: 0,
                                maxOutputTokens: settings.maxTokens,
                                responseMimeType: 'application/json',
                            },
                        }),
                    },
                ).then(async function(response) {
                    if (!response.ok) {
                        throw new Error('Gemini request failed with status ' + response.status + ': ' + await response.text());
                    }
                    return response.json();
                }),
                settings.timeoutMs
            );
            break;
        } catch (err) {
            if (!isRetryableGeminiError(err) || attempt === settings.retryCount) {
                throw err;
            }
            await wait(settings.retryDelayMs * (attempt + 1));
        }
    }

    const text = result.candidates && result.candidates[0] &&
        result.candidates[0].content && result.candidates[0].content.parts &&
        result.candidates[0].content.parts
            .map(function(part) { return part && typeof part.text === 'string' ? part.text : ''; })
            .join('')
            .trim();
    const items = parseJsonArray(text);

    const found = {};
    if (items) {
        items.forEach(function(item) {
            const normalized = normalizeItem(item);
            if (normalized) found[normalized.id] = normalized;
        });
    }

    const failedIds = batch
        .map(function(p) { return String(p.id); })
        .filter(function(id) { return !found[id]; });

    return { found: found, failedIds: failedIds };
}

// products: [{ id, title, brand, breadcrumb, description }]
// Never throws.
async function classifyProducts(products) {
    const output = {};

    if (!config.gemini.enabled) {
        return output; // no key configured - silently skip
    }
    if (!Array.isArray(products) || products.length === 0) {
        return output;
    }

    // 1. Answer from cache where possible
    const pending = [];
    products.forEach(function(p) {
        if (!p || p.id === undefined || p.id === null || !p.title) return;
        const hit = cache.get(cacheKey(p));
        if (hit) {
            output[String(p.id)] = {
                id: String(p.id),
                category: hit.category,
                isAccessory: hit.isAccessory,
                confidence: hit.confidence,
                source: 'cache',
            };
        } else {
            pending.push(p);
        }
    });

    // 2. Send the rest in small batches, one at a time (free-tier rate limits)
    const settings = getSettings();
    for (let i = 0; i < pending.length; i += settings.batchSize) {
        const batch = pending.slice(i, i + settings.batchSize);

        try {
            const first = await classifyBatch(batch, settings);
            const found = first.found;

            // One retry, only for items with invalid / missing output
            if (first.failedIds.length > 0) {
                const retryBatch = batch.filter(function(p) {
                    return first.failedIds.indexOf(String(p.id)) !== -1;
                });
                try {
                    const second = await classifyBatch(retryBatch, settings);
                    Object.keys(second.found).forEach(function(id) { found[id] = second.found[id]; });
                } catch (retryErr) {
                    logger.warn('AI category retry failed - keeping first-pass results', { message: retryErr.message });
                }
            }

            batch.forEach(function(p) {
                const r = found[String(p.id)];
                if (!r) return;
                output[String(p.id)] = r;
                if (r.category !== UNKNOWN) remember(p, r);
            });
        } catch (err) {
            // Expected, non-exceptional (down / rate-limited / timed out): warn, not error
            logger.warn('AI category batch failed - continuing without it', {
                message: err.message,
                batchSize: batch.length,
            });
        }
    }

    logger.info('AI category classification finished', {
        requested: products.length,
        classified: Object.keys(output).length,
    });
    return output;
}

module.exports = { classifyProducts, CATEGORIES };