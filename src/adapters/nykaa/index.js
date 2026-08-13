// src/adapters/nykaa/index.js
//
// No official Nykaa API exists, so this simply re-exports the scraper.
// Kept as its own file so services never import nykaa.scraper.js
// directly - same reasoning as adapters/lenskart/index.js.

'use strict';

module.exports = require('./nykaa.scraper');
