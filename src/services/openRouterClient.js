// src/services/openRouterClient.js
//
// Isolated on purpose: @openrouter/sdk is ESM-only (see its package.json's
// "type": "module"), so loading it from this CommonJS codebase requires a
// dynamic import() rather than require(). Jest's mock registry only
// intercepts require() calls routed through its own module system - this
// project has no babel transform to turn import() into one of those - so
// jest.mock('@openrouter/sdk') silently does nothing and a test ends up
// hitting the real package. Keeping the import() in its own plain CJS
// file means aiComparison.service.js's tests can mock THIS file instead
// (an ordinary require(), which Jest handles like any other local module).

'use strict';

const config = require('../config/env');

let clientPromise = null;

function getClient() {
    if (!clientPromise) {
        clientPromise = import('@openrouter/sdk').then(function(mod) {
            return new mod.OpenRouter({ apiKey: config.openRouter.apiKey });
        });
    }
    return clientPromise;
}

module.exports = { getClient };
