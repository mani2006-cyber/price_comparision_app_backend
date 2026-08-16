// src/adapters/provider.interface.js
//
// The contract every marketplace adapter must satisfy, regardless of
// whether it scrapes HTML or calls an official API. This is what makes
// "swap scraper for official API later" a one-file change: the service
// layer only ever talks to this shape, never to a specific
// implementation.
//
// Every adapter module (see adapters/amazon/index.js etc.) must export:
//
//   async function searchByQuery(query, options)
//     -> Promise<Array<ProviderProduct>>
//
//   async function searchByLink(url)
//     -> Promise<ProviderProduct | null>
//
// Both functions return objects in the ProviderProduct shape below (or
// an array of them). Call validateProviderProduct() on every object
// before returning it from an adapter - this is what turns "the adapter
// silently returned a malformed object" into an immediate, clear error
// at the source, instead of a confusing failure three layers away in
// product.repository.js or Mongoose validation.
//
// ProviderProduct shape (matches Product.model.js exactly):
// {
//   marketplace: 'amazon' | 'flipkart' | 'myntra' | 'ajio' | 'lenskart' |
//                'nykaa' | 'poorvika' | 'vijaysales',  // required
//   externalId: string,        // required - STABLE id extracted from the URL (ASIN, pid, etc), NEVER random
//   sku: string | null,
//   title: string,             // required
//   brand: string | null,
//   category: string | null,
//   categoryPath: string[],
//   images: string[],          // max 10 - see Product.model.js
//   currentPrice: number,      // required
//   originalPrice: number | null,
//   discountPercentage: number | null,   // leave null to let the model auto-compute it
//   currency: string,          // default 'INR' if omitted
//   rating: { average: number | null, reviews: number | null },
//   seller: { name: string | null, rating: number | null },
//   availability: 'in_stock' | 'out_of_stock' | 'limited' | 'preorder' | 'unknown',
//   delivery: { estimate: string | null, free: boolean | null },
//   rawUrl: string,            // required
//   affiliateUrl: string | null,
//   keywords: string[],
//   attributes: { [key: string]: string },
//   fetchedVia: 'scraper' | 'api',   // required - MUST match how this adapter actually got the data
//   metadata: object,
// }

'use strict';

const config = require('../config/env');

const REQUIRED_FIELDS = ['marketplace', 'externalId', 'title', 'currentPrice', 'rawUrl', 'fetchedVia'];

const VALID_MARKETPLACES = ['amazon', 'flipkart', 'myntra', 'ajio', 'lenskart', 'nykaa', 'poorvika', 'vijaysales'];
const VALID_FETCHED_VIA = ['scraper', 'api'];
const VALID_AVAILABILITY = ['in_stock', 'out_of_stock', 'limited', 'preorder', 'unknown'];

// Thrown when an adapter's output doesn't satisfy the contract. Distinct
// from ApiError - this is a development-time/integration bug (a broken
// adapter), not a normal request-flow error a client should see
// formatted as a 4xx. Callers (services) should let this propagate to
// the generic 500 path in errorHandler.js.
class ProviderContractError extends Error {
    constructor(message, receivedData) {
        super(message);
        this.name = 'ProviderContractError';
        this.receivedData = receivedData;
    }
}

// Validates a single ProviderProduct object. Throws ProviderContractError
// on any violation. Returns the object unchanged if valid (so it can be
// used inline: return validateProviderProduct(result);).
function validateProviderProduct(data) {
    if (!data || typeof data !== 'object') {
        throw new ProviderContractError('Adapter returned a non-object result', data);
    }

    for (let i = 0; i < REQUIRED_FIELDS.length; i++) {
        const field = REQUIRED_FIELDS[i];
        if (data[field] === undefined || data[field] === null || data[field] === '') {
            throw new ProviderContractError(
                'Adapter output is missing required field "' + field + '"',
                data
            );
        }
    }

    if (VALID_MARKETPLACES.indexOf(data.marketplace) === -1) {
        throw new ProviderContractError(
            'Adapter output has invalid marketplace: ' + data.marketplace,
            data
        );
    }

    if (VALID_FETCHED_VIA.indexOf(data.fetchedVia) === -1) {
        throw new ProviderContractError(
            'Adapter output has invalid fetchedVia: ' + data.fetchedVia + ' (must be "scraper" or "api")',
            data
        );
    }

    if (typeof data.currentPrice !== 'number' || data.currentPrice < 0 || Number.isNaN(data.currentPrice)) {
        throw new ProviderContractError(
            'Adapter output has invalid currentPrice: ' + data.currentPrice,
            data
        );
    }

    if (data.availability !== undefined && VALID_AVAILABILITY.indexOf(data.availability) === -1) {
        throw new ProviderContractError(
            'Adapter output has invalid availability: ' + data.availability,
            data
        );
    }

    if (data.images !== undefined && !Array.isArray(data.images)) {
        throw new ProviderContractError('Adapter output "images" must be an array', data);
    }

    if (data.images !== undefined && data.images.length > config.product.maxImages) {
        throw new ProviderContractError('Adapter output "images" exceeds max of ' + config.product.maxImages, data);
    }

    return data;
}

// Validates an array of results (the shape searchByQuery returns).
// Skips (does not throw on) individual bad entries by default is
// deliberately NOT the behavior here - we want a broken adapter to fail
// loudly during development, not silently drop results in production.
function validateProviderProductList(dataArray) {
    if (!Array.isArray(dataArray)) {
        throw new ProviderContractError('Adapter searchByQuery must return an array', dataArray);
    }
    return dataArray.map(validateProviderProduct);
}

// Fills in sensible defaults for optional fields an adapter chose not to
// set, so adapters can stay terse (only specify what they actually
// know) while the object handed to product.repository.js is always
// complete and predictable.
function withDefaults(data) {
    return Object.assign({
            sku: null,
            brand: null,
            category: null,
            categoryPath: [],
            images: [],
            originalPrice: null,
            discountPercentage: null,
            currency: 'INR',
            rating: { average: null, reviews: null },
            seller: { name: null, rating: null },
            availability: 'unknown',
            delivery: { estimate: null, free: null },
            affiliateUrl: null,
            keywords: [],
            attributes: {},
            metadata: {},
        },
        data
    );
}

module.exports = {
    ProviderContractError,
    validateProviderProduct,
    validateProviderProductList,
    withDefaults,
    VALID_MARKETPLACES,
    VALID_FETCHED_VIA,
    VALID_AVAILABILITY,
};