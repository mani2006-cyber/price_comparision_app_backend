// src/adapters/amazon/index.js
//
// Orchestrates amazon.api.js and amazon.scraper.js behind
// AMAZON_PROVIDER_MODE. This is the ONLY Amazon adapter file the rest
// of the codebase should ever import - services must never reach into
// amazon.api.js or amazon.scraper.js directly. Whichever mode is active,
// callers get back valid ProviderProduct results (or a clean failure)
// with zero awareness of which implementation actually ran.

'use strict';

const config = require('../../config/env');
const logger = require('../../utils/logger');
const amazonApi = require('./amazon.api');
const amazonScraper = require('./amazon.scraper');

const MODE = config.providerModes.amazon; // 'scraper' | 'api' | 'auto'

async function searchByQuery(query, options) {
    if (MODE === 'scraper') {
        return amazonScraper.searchByQuery(query, options);
    }

    if (MODE === 'api') {
        return amazonApi.searchByQuery(query, options);
    }

    try {
        return await amazonApi.searchByQuery(query, options);
    } catch (err) {
        logger.warn('Amazon API search failed, falling back to scraper', {
            query,
            message: err.message,
        });
        return amazonScraper.searchByQuery(query, options);
    }
}

async function searchByLink(url) {
    if (MODE === 'scraper') {
        return amazonScraper.searchByLink(url);
    }

    if (MODE === 'api') {
        return amazonApi.searchByLink(url);
    }

    try {
        return await amazonApi.searchByLink(url);
    } catch (err) {
        logger.warn('Amazon API product lookup failed, falling back to scraper', {
            url,
            message: err.message,
        });
        return amazonScraper.searchByLink(url);
    }
}

module.exports = { searchByQuery, searchByLink };