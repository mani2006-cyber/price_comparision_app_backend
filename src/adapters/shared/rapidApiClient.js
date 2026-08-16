// src/adapters/shared/rapidApiClient.js
//
// Thin, shared wrapper for calling RapidAPI endpoints. Used by every
// official-API adapter (amazon.api.js, flipkart.api.js, ...). Normalizes
// all failure modes (timeout, auth, rate limit, upstream error) into one
// RapidApiError shape, so callers can make a single simple decision:
// "did this fail? fall back to the scraper" - without parsing axios
// error internals themselves.

'use strict';

const axios = require('axios');
const logger = require('../../utils/logger');
const config = require('../../config/env');

const TIMEOUT_MS = config.rapidApi.timeoutMs;

class RapidApiError extends Error {
    constructor(message, statusCode, host) {
        super(message);
        this.name = 'RapidApiError';
        this.statusCode = statusCode || null;
        this.host = host || null;
    }
}

// ── Core request function ───────────────────────────────────────────────
//
// endpoint: full https:// URL for the RapidAPI endpoint
// params:   query params object
// key/host: the specific subscription's credentials (from config.providerApis)
async function rapidApiGet(endpoint, params, key, host) {
    if (!key || !host) {
        throw new RapidApiError('RapidAPI key/host not configured for this endpoint', null, host);
    }

    try {
        const response = await axios.get(endpoint, {
            params,
            timeout: TIMEOUT_MS,
            headers: {
                'x-rapidapi-key': key,
                'x-rapidapi-host': host,
                'Content-Type': 'application/json',
            },
        });

        return response.data;
    } catch (err) {
        // Distinguish "the request went out and RapidAPI responded with an
        // error status" from "the request never got a response at all"
        // (timeout, DNS failure, connection refused) - useful in logs for
        // telling a bad key apart from a network issue.
        if (err.response) {
            logger.warn('RapidAPI request failed with error status', {
                host,
                endpoint,
                status: err.response.status,
            });
            throw new RapidApiError(
                'RapidAPI request failed with status ' + err.response.status,
                err.response.status,
                host
            );
        }

        logger.warn('RapidAPI request failed with no response', {
            host,
            endpoint,
            message: err.message,
        });
        throw new RapidApiError('RapidAPI request failed: ' + err.message, null, host);
    }
}

module.exports = { rapidApiGet, RapidApiError };