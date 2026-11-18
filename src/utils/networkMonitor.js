'use strict';

const axios = require('axios');
const logger = require('./logger');

function getDestination(requestConfig) {
    try {
        const url = new URL(requestConfig.url, requestConfig.baseURL || 'http://unknown.local');
        return {
            destinationHostname: url.hostname,
            endpoint: url.hostname + url.pathname,
        };
    } catch (err) {
        return {
            destinationHostname: null,
            endpoint: '[unparseable-url]',
        };
    }
}

function getEndpoint(requestConfig) {
    return getDestination(requestConfig).endpoint;
}

function getResponseTime(startedAt) {
    if (!startedAt) {
        return null;
    }
    const elapsed = process.hrtime(startedAt);
    return Math.round((elapsed[0] * 1000 + elapsed[1] / 1000000) * 100) / 100;
}

function getErrorCode(error) {
    return error && (error.code || (error.cause && error.cause.code)) || null;
}

function logRequest(requestConfig, response, error) {
    if (!requestConfig) {
        return;
    }

    const responseStatus = response && response.status;
    const destination = getDestination(requestConfig);
    const failed = !!error || (responseStatus !== undefined && responseStatus >= 400);
    const fields = {
        direction: 'outbound',
        method: String(requestConfig.method || 'get').toUpperCase(),
        destinationHostname: destination.destinationHostname,
        endpoint: destination.endpoint,
        httpStatus: responseStatus || null,
        responseTimeMs: getResponseTime(requestConfig.__networkMonitorStartedAt),
        outcome: failed ? 'failure' : 'success',
    };

    if (error) {
        fields.errorName = error.name || 'Error';
        fields.errorCode = getErrorCode(error);
    }

    logger.network('Outbound HTTP request ' + fields.outcome, fields, failed ? 'warn' : 'info');
}

function logFetch(input, init, response, error, startedAt) {
    const requestUrl = input && typeof input === 'object' && input.url ? input.url : String(input);
    const method = (init && init.method) || (input && input.method) || 'GET';
    const destination = getDestination({ url: requestUrl });
    const responseStatus = response && response.status;
    const failed = !!error || (responseStatus !== undefined && responseStatus >= 400);
    const fields = {
        direction: 'outbound',
        method: String(method).toUpperCase(),
        destinationHostname: destination.destinationHostname,
        endpoint: destination.endpoint,
        httpStatus: responseStatus || null,
        responseTimeMs: getResponseTime(startedAt),
        outcome: failed ? 'failure' : 'success',
    };

    if (error) {
        fields.errorName = error.name || 'Error';
        fields.errorCode = getErrorCode(error);
    }

    logger.network('Outbound fetch request ' + fields.outcome, fields, failed ? 'warn' : 'info');
}

axios.interceptors.request.use(function(requestConfig) {
    requestConfig.__networkMonitorStartedAt = process.hrtime();
    return requestConfig;
});

axios.interceptors.response.use(
    function(response) {
        logRequest(response.config, response, null);
        return response;
    },
    function(error) {
        logRequest(error.config, error.response, error);
        return Promise.reject(error);
    }
);

if (typeof global.fetch === 'function') {
    const originalFetch = global.fetch;
    global.fetch = function(input, init) {
        const startedAt = process.hrtime();
        return originalFetch.call(this, input, init).then(
            function(response) {
                logFetch(input, init, response, null, startedAt);
                return response;
            },
            function(error) {
                logFetch(input, init, null, error, startedAt);
                return Promise.reject(error);
            }
        );
    };
}

module.exports = { getEndpoint, getDestination, logRequest };
