'use strict';

const dns = require('dns');
const https = require('https');
const net = require('net');
const axios = require('axios');
const config = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const securityMonitorAgent = require('../../security/securityMonitorAgent');

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

const MARKETPLACE_DOMAINS = {
    amazon: ['amazon.in'],
    flipkart: ['flipkart.com'],
    myntra: ['myntra.com'],
    lenskart: ['lenskart.com'],
    nykaa: ['nykaa.com'],
    poorvika: ['poorvika.com'],
    vijaysales: ['vijaysales.com'],
};

const blockedIpv4Addresses = new net.BlockList();
[
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
].forEach(function(subnet) {
    blockedIpv4Addresses.addSubnet(subnet[0], subnet[1], 'ipv4');
});
const blockedIpv6Addresses = new net.BlockList();
[
    ['::', 96],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
].forEach(function(subnet) {
    blockedIpv6Addresses.addSubnet(subnet[0], subnet[1], 'ipv6');
});

const globalIpv6Addresses = new net.BlockList();
globalIpv6Addresses.addSubnet('2000::', 3, 'ipv6');

function getMarketplaceForHost(hostname) {
    if (typeof hostname !== 'string') {
        return null;
    }

    const normalizedHost = hostname.toLowerCase().replace(/\.$/, '');
    const marketplaces = Object.keys(MARKETPLACE_DOMAINS);

    for (let i = 0; i < marketplaces.length; i++) {
        const marketplace = marketplaces[i];
        const matchesDomain = MARKETPLACE_DOMAINS[marketplace].some(function(domain) {
            return normalizedHost === domain || normalizedHost.endsWith('.' + domain);
        });

        if (matchesDomain) {
            return marketplace;
        }
    }

    return null;
}

function unsafeDestinationError(statusCode, message) {
    const error = statusCode === 400
        ? ApiError.badRequest(message)
        : ApiError.badGateway(message);
    error.code = 'ERR_UNSAFE_DESTINATION';
    return error;
}

function validateMarketplaceUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch (err) {
        throw unsafeDestinationError(400, 'A valid HTTPS URL from a supported marketplace is required');
    }

    if (url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !getMarketplaceForHost(url.hostname)) {
        throw unsafeDestinationError(400, 'A valid HTTPS URL from a supported marketplace is required');
    }

    return url;
}

function isPublicAddress(address) {
    const family = net.isIP(address);
    if (family === 0) {
        return false;
    }

    if (family === 6 && !globalIpv6Addresses.check(address, 'ipv6')) {
        return false;
    }

    const blockedAddresses = family === 4 ? blockedIpv4Addresses : blockedIpv6Addresses;
    return !blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function createPublicLookup(resolve) {
    const lookupResolver = resolve || dns.lookup;

    return function publicLookup(hostname, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }

        const lookupOptions = typeof options === 'number' ? { family: options } : (options || {});
        lookupResolver(hostname, { all: true, verbatim: true }, function(err, addresses) {
            if (err) {
                callback(err);
                return;
            }

            if (!Array.isArray(addresses) || addresses.length === 0 ||
                addresses.some(function(result) {
                    return !result || net.isIP(result.address) !== result.family || !isPublicAddress(result.address);
                })) {
                const unsafeAddressError = new Error('Marketplace hostname resolved to a non-public address');
                unsafeAddressError.code = 'ERR_UNSAFE_DESTINATION';
                callback(unsafeAddressError);
                return;
            }

            const family = Number(lookupOptions.family) || 0;
            const candidates = family
                ? addresses.filter(function(result) { return result.family === family; })
                : addresses;

            if (candidates.length === 0) {
                const familyError = new Error('No address found for the requested family');
                familyError.code = 'ENOTFOUND';
                callback(familyError);
                return;
            }

            if (lookupOptions.all) {
                callback(null, candidates);
                return;
            }

            callback(null, candidates[0].address, candidates[0].family);
        });
    };
}

function isRedirectStatus(status) {
    return REDIRECT_STATUSES.indexOf(status) !== -1;
}

function getResponseLimit(requestOptions) {
    const requestedLimit = requestOptions.maxContentLength;
    if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
        return Math.min(requestedLimit, MAX_RESPONSE_BYTES);
    }
    return MAX_RESPONSE_BYTES;
}

async function safeGet(value, requestOptions) {
    const options = requestOptions || {};
    const configuredTimeout = config.scraper && config.scraper.timeoutMs;
    const timeoutMs = Number.isFinite(options.timeout) && options.timeout > 0
        ? options.timeout
        : (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 20000);
    const maxContentLength = getResponseLimit(options);
    let currentUrl = validateMarketplaceUrl(value);
    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(function() {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const requestHeaders = Object.assign({}, options.headers || {});

    try {
        for (let redirects = 0; ; redirects++) {
            const remainingMs = timeoutMs - (Date.now() - startedAt);
            if (remainingMs <= 0) {
                timedOut = true;
                throw ApiError.badGateway('Marketplace request timed out');
            }

            const agent = new https.Agent({ lookup: createPublicLookup() });
            let response;
            try {
                const originalValidateStatus = options.validateStatus;
                response = await axios.get(currentUrl.href, Object.assign({}, options, {
                    headers: requestHeaders,
                    timeout: remainingMs,
                    signal: controller.signal,
                    maxContentLength: maxContentLength,
                    maxRedirects: 0,
                    httpsAgent: agent,
                    proxy: false,
                    validateStatus: function(status) {
                        if (isRedirectStatus(status)) {
                            return true;
                        }
                        return typeof originalValidateStatus === 'function'
                            ? originalValidateStatus(status)
                            : status >= 200 && status < 300;
                    },
                }));
            } catch (err) {
                if (controller.signal.aborted) {
                    throw ApiError.badGateway('Marketplace request timed out');
                }
                if (err.code === 'ERR_UNSAFE_DESTINATION' ||
                    (err.cause && err.cause.code === 'ERR_UNSAFE_DESTINATION')) {
                    throw unsafeDestinationError(502, 'Marketplace hostname resolved to a non-public address');
                }
                throw err;
            } finally {
                agent.destroy();
            }

            if (!isRedirectStatus(response.status)) {
                return response;
            }

            if (redirects >= MAX_REDIRECTS) {
                throw unsafeDestinationError(502, 'Marketplace exceeded the redirect limit');
            }

            const location = response.headers && response.headers.location;
            if (!location) {
                throw unsafeDestinationError(502, 'Marketplace returned a redirect without a destination');
            }

            try {
                const nextUrl = validateMarketplaceUrl(new URL(location, currentUrl).href);
                if (nextUrl.hostname !== currentUrl.hostname) {
                    Object.keys(requestHeaders).forEach(function(headerName) {
                        const normalizedName = headerName.toLowerCase();
                        if (normalizedName === 'authorization' ||
                            normalizedName === 'cookie' ||
                            normalizedName === 'proxy-authorization') {
                            delete requestHeaders[headerName];
                        }
                    });
                }
                currentUrl = nextUrl;
            } catch (err) {
                throw unsafeDestinationError(502, 'Marketplace redirected to an unsupported destination');
            }
        }
    } catch (err) {
        const unsafeDestination = err && (err.code === 'ERR_UNSAFE_DESTINATION' ||
            (err.cause && err.cause.code === 'ERR_UNSAFE_DESTINATION'));
        if (!unsafeDestination) {
            const status = err && err.response && err.response.status;
            const errorCode = timedOut ? 'TIMEOUT' :
                (err && (err.code || (status ? 'UPSTREAM_HTTP_ERROR' : 'NETWORK_ERROR')));
            securityMonitorAgent.reportOutboundFailure(
                currentUrl.href,
                status,
                Date.now() - startedAt,
                errorCode
            );
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    MAX_REDIRECTS,
    MAX_RESPONSE_BYTES,
    getMarketplaceForHost,
    validateMarketplaceUrl,
    isPublicAddress,
    createPublicLookup,
    safeGet,
};
