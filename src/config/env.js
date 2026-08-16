// src/config/env.js
//
// Loads and validates environment variables. This file must be required
// before any other module that depends on process.env, which is why
// server.js requires "dotenv" first, and this file is required immediately
// after that.

'use strict';

const path = require('path');

// Loads .env.test instead of .env when NODE_ENV=test - this is what
// lets the test suite point at a completely separate MongoDB database
// without touching real .env values at all. Falls back to the normal
// .env for every other environment (development, production).
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
require('dotenv').config({ path: path.resolve(process.cwd(), envFile) });

// ── Small helpers ───────────────────────────────────────────────────────

function getString(name, fallback) {
    const value = process.env[name];
    if (value === undefined || value === '') {
        return fallback;
    }
    return value;
}

function getRequiredString(name) {
    const value = process.env[name];
    if (value === undefined || value === '') {
        throw new Error(
            'Missing required environment variable: ' + name +
            '. Check your .env file against .env.example.'
        );
    }
    return value;
}

function getNumber(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        throw new Error('Environment variable ' + name + ' must be a number, got: ' + raw);
    }
    return parsed;
}

function getCsvList(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    return raw.split(',').map(function(item) {
        return item.trim();
    }).filter(function(item) {
        return item.length > 0;
    });
}

const VALID_PROVIDER_MODES = ['scraper', 'api', 'auto'];

function getProviderMode(name) {
    const value = getString(name, 'scraper').toLowerCase();
    if (VALID_PROVIDER_MODES.indexOf(value) === -1) {
        throw new Error(
            'Environment variable ' + name + ' must be one of "scraper", "api", "auto" - got: ' + value
        );
    }
    return value;
}

// ── Build the config object ─────────────────────────────────────────────

const config = {
    env: getString('NODE_ENV', 'development'),
    isProduction: getString('NODE_ENV', 'development') === 'production',
    port: getNumber('PORT', 5000),

    mongoUri: getRequiredString('MONGO_URI'),

    accessToken: {
        secret: getRequiredString('ACCESS_TOKEN_SECRET'),
        expiresIn: getString('ACCESS_TOKEN_EXPIRES_IN', '15m'),
    },

    refreshToken: {
        secret: getRequiredString('REFRESH_TOKEN_SECRET'),
        expiresIn: getString('REFRESH_TOKEN_EXPIRES_IN', '7d'),
    },

    cookie: {
        secure: getString('COOKIE_SECURE', 'false') === 'true',
        // No hardcoded default here anymore - see auth.controller.js's
        // setRefreshCookie for why an explicit domain is actively harmful
        // as a default (breaks any client accessing the API by IP or a
        // different hostname than exactly what's configured, which is
        // precisely what caused Supertest's cookie to silently not be sent).
        domain: getString('COOKIE_DOMAIN', null),
        refreshCookieName: getString('REFRESH_COOKIE_NAME', 'refreshToken'),
    },

    bcryptSaltRounds: getNumber('BCRYPT_SALT_ROUNDS', 10),

    cache: {
        ttlSeconds: getNumber('CACHE_TTL_SECONDS', 600),
    },

    redis: {
        enabled: getString('REDIS_ENABLED', 'true') === 'true',
        url: getString('REDIS_URL', 'redis://127.0.0.1:6379'),
        keyPrefix: getString('REDIS_KEY_PREFIX', 'pricecompare:'),
    },

    cacheTtl: {
        search: getNumber('CACHE_SEARCH_TTL_SECONDS', 300),
        product: getNumber('CACHE_PRODUCT_TTL_SECONDS', 300),
        compare: getNumber('CACHE_COMPARE_TTL_SECONDS', 600),
        category: getNumber('CACHE_CATEGORY_TTL_SECONDS', 600),
        // Short by design - notifications are also actively invalidated on
        // every write (see notification.repository.js), so this TTL is
        // only a safety net for a missed invalidation, not the primary
        // freshness mechanism the way it is for search/product/compare.
        notifications: getNumber('CACHE_NOTIFICATIONS_TTL_SECONDS', 60),
    },

    rateLimit: {
        windowMs: getNumber('RATE_LIMIT_WINDOW_MS', 60000),
        max: getNumber('RATE_LIMIT_MAX', 20),
    },
    authRateLimit: {
        windowMs: getNumber('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
        max: getNumber('AUTH_RATE_LIMIT_MAX', 10),
    },
    // Was hardcoded directly in product.routes.js (windowMs: 60000, max: 10)
    // rather than read from here like every other rate limiter - the one
    // limiter you couldn't tune without a code change and a restart.
    compareRateLimit: {
        windowMs: getNumber('COMPARE_RATE_LIMIT_WINDOW_MS', 60000),
        max: getNumber('COMPARE_RATE_LIMIT_MAX', 10),
    },

    corsOrigins: getCsvList('CORS_ORIGINS', ['http://localhost:5173']),

    compare: {
        similarityThreshold: getNumber('SIMILARITY_THRESHOLD', 0.2),
        maxCrossMatches: getNumber('MAX_CROSS_MATCHES', 5),
        // How far apart two prices can be and still plausibly be the same
        // real product across marketplaces (src/utils/similarity.js's
        // passesPriceGate) - were bare module-level consts there.
        minPriceRatio: getNumber('COMPARE_MIN_PRICE_RATIO', 0.4),
        maxPriceRatio: getNumber('COMPARE_MAX_PRICE_RATIO', 2.5),
        // Below this, two titles share too little real vocabulary to be
        // plausibly the same product (similarity.js's own comment has the
        // full "Fujifilm camera" regression story behind this exact value).
        minTitleSimilarity: getNumber('COMPARE_MIN_TITLE_SIMILARITY', 0.12),
    },

    priceRefresher: {
        cronSchedule: getString('PRICE_REFRESHER_CRON', '0 */6 * * *'),
        delayMs: getNumber('PRICE_REFRESHER_DELAY_MS', 2000),
    },

    // Shared by every scraper-based adapter (amazon/flipkart's fallback
    // path, myntra/lenskart/nykaa/poorvika/vijaysales always) - each used
    // to hardcode its own axios timeout (a mix of 15000/20000) and its own
    // MAX_SEARCH_RESULTS = 8 independently - 7 near-identical constants
    // duplicated instead of one shared, tunable value.
    scraper: {
        timeoutMs: getNumber('SCRAPER_TIMEOUT_MS', 20000),
        maxSearchResults: getNumber('SCRAPER_MAX_SEARCH_RESULTS', 8),
    },

    // amazon.scraper.js's retry/backoff/circuit-breaker tuning - the most
    // elaborate resilience logic of any adapter (the others just fail
    // once and report the error), so it gets its own dedicated group
    // rather than folding into the shared `scraper` one above.
    amazonScraper: {
        maxRetries: getNumber('AMAZON_SCRAPER_MAX_RETRIES', 4),
        baseDelayMs: getNumber('AMAZON_SCRAPER_BASE_DELAY_MS', 1000),
        maxDelayMs: getNumber('AMAZON_SCRAPER_MAX_DELAY_MS', 15000),
        circuitFailureThreshold: getNumber('AMAZON_SCRAPER_CIRCUIT_FAILURE_THRESHOLD', 3),
        circuitCooldownMs: getNumber('AMAZON_SCRAPER_CIRCUIT_COOLDOWN_MS', 5 * 60 * 1000),
    },

    // amazon.api.js/flipkart.api.js's official-API search result cap -
    // deliberately separate from scraper.maxSearchResults above (20 vs 8)
    // since a paid/metered API call has a different cost profile than a
    // scrape, and the two have always been tuned independently.
    apiSearch: {
        maxResults: getNumber('API_MAX_SEARCH_RESULTS', 20),
    },

    rapidApi: {
        timeoutMs: getNumber('RAPIDAPI_TIMEOUT_MS', 10000),
    },

    sse: {
        heartbeatMs: getNumber('SSE_HEARTBEAT_MS', 25000),
    },

    product: {
        // Product.model.js's own schema validator caps images at this -
        // was a bare module-level const there.
        maxImages: getNumber('PRODUCT_MAX_IMAGES', 10),
    },

    category: {
        defaultLimit: getNumber('CATEGORY_DEFAULT_LIMIT', 20),
        // The validator (categoryProductsQuerySchema) rejects a limit
        // above this - was a bare literal (50) in product.validators.js.
        maxLimit: getNumber('CATEGORY_MAX_LIMIT', 50),
    },

    // Per-provider mode ("scraper" | "api" | "auto"). Adapters read ONLY
    // their own entry here.
    providerModes: {
        amazon: getProviderMode('AMAZON_PROVIDER_MODE'),
        flipkart: getProviderMode('FLIPKART_PROVIDER_MODE'),
        myntra: getProviderMode('MYNTRA_PROVIDER_MODE'),
        ajio: getProviderMode('AJIO_PROVIDER_MODE'),
        lenskart: getProviderMode('LENSKART_PROVIDER_MODE'),
    },

    // Official API credentials - only required when the matching
    // providerModes entry is "api" or "auto" (validated below).
    providerApis: {
        amazon: {
            key: getString('AMAZON_RAPIDAPI_KEY', null),
            host: getString('AMAZON_RAPIDAPI_HOST', 'real-time-amazon-data.p.rapidapi.com'),
            country: getString('AMAZON_API_COUNTRY', 'IN'),
        },
        flipkart: {
            key: getString('FLIPKART_RAPIDAPI_KEY', null),
            host: getString('FLIPKART_RAPIDAPI_HOST', 'real-time-flipkart-data2.p.rapidapi.com'),
        },
    },

    // Optional - powers the AI-generated summary on /api/compare-url (see
    // src/services/aiComparison.service.js). Same "no hard dependency"
    // pattern as redis above: `enabled` is derived from whether a key is
    // configured at all, never required to boot the app.
    openRouter: {
        enabled: !!getString('OPENROUTER_API_KEY', null),
        apiKey: getString('OPENROUTER_API_KEY', null),
        model: getString('OPENROUTER_MODEL', 'nvidia/nemotron-3-ultra-550b-a55b:free'),
        timeoutMs: getNumber('OPENROUTER_TIMEOUT_MS', 20000),
        // Were bare literals in aiComparison.service.js's own chat.send() call.
        maxTokens: getNumber('OPENROUTER_MAX_TOKENS', 200),
        temperature: getNumber('OPENROUTER_TEMPERATURE', 0.4),
    },
};

// ── Cross-field validation ────────────────────────────────────────────
// Some fields are only "required" conditionally on another field's
// value (e.g. an API key is only required if that marketplace's mode
// is "api" or "auto"). That can't be expressed with the simple
// getRequiredString() helper above, so it's checked here, once, right
// after the config object is fully built - fail fast at startup rather
// than the first time a request happens to hit that marketplace.
function validateProviderCredentials() {
    const marketplacesWithApis = ['amazon', 'flipkart'];

    marketplacesWithApis.forEach(function(marketplace) {
        const mode = config.providerModes[marketplace];
        const needsApiKey = mode === 'api' || mode === 'auto';
        const hasApiKey = !!config.providerApis[marketplace].key;

        if (needsApiKey && !hasApiKey) {
            throw new Error(
                marketplace.toUpperCase() + '_PROVIDER_MODE is "' + mode + '" but ' +
                marketplace.toUpperCase() + '_RAPIDAPI_KEY is missing. ' +
                'Either set the API key in .env, or set the mode to "scraper".'
            );
        }
    });
}

// The two JWT secrets must never be identical - if one leaks (e.g. via
// a misconfigured log or a compromised .env), the other token type must
// still be safe. A shared secret would defeat that isolation entirely.
function validateTokenSecretsAreDistinct() {
    if (config.accessToken.secret === config.refreshToken.secret) {
        throw new Error(
            'ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be different values. ' +
            'Generate two separate random strings.'
        );
    }
}

validateProviderCredentials();
validateTokenSecretsAreDistinct();

module.exports = config;