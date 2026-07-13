// src/adapters/flipkart/index.js
//
// Orchestrates flipkart.api.js and flipkart.scraper.js behind
// FLIPKART_PROVIDER_MODE. This is the ONLY Flipkart adapter file the
// rest of the codebase should ever import. Same routing pattern as
// adapters/amazon/index.js - see that file's comments for the full
// reasoning on each mode.

'use strict';

const config = require('../../config/env');
const logger = require('../../utils/logger');
const flipkartApi = require('./flipkart.api');
const flipkartScraper = require('./flipkart.scraper');

const MODE = config.providerModes.flipkart; // 'scraper' | 'api' | 'auto'

async function searchByQuery(query, options) {
    if (MODE === 'scraper') {
        return flipkartScraper.searchByQuery(query, options);
    }

    if (MODE === 'api') {
        return flipkartApi.searchByQuery(query, options);
    }

    try {
        return await flipkartApi.searchByQuery(query, options);
    } catch (err) {
        logger.warn('Flipkart API search failed, falling back to scraper', {
            query,
            message: err.message,
        });
        return flipkartScraper.searchByQuery(query, options);
    }
}

async function searchByLink(url) {
    if (MODE === 'scraper') {
        return flipkartScraper.searchByLink(url);
    }

    if (MODE === 'api') {
        return flipkartApi.searchByLink(url);
    }

    try {
        return await flipkartApi.searchByLink(url);
    } catch (err) {
        logger.warn('Flipkart API product lookup failed, falling back to scraper', {
            url,
            message: err.message,
        });
        return flipkartScraper.searchByLink(url);
    }
}

module.exports = { searchByQuery, searchByLink };