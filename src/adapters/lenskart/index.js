// src/adapters/lenskart/index.js
//
// No official Lenskart API exists, so this simply re-exports the
// scraper. Kept as its own file so services never import
// lenskart.scraper.js directly - same reasoning as adapters/myntra/index.js.

'use strict';

module.exports = require('./lenskart.scraper');