// src/adapters/poorvika/index.js
//
// No official Poorvika API exists, so this simply re-exports the
// scraper. Kept as its own file so services never import
// poorvika.scraper.js directly - same reasoning as adapters/lenskart/index.js.

'use strict';

module.exports = require('./poorvika.scraper');
