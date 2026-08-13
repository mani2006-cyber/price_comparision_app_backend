// src/adapters/vijaysales/index.js
//
// No official Vijay Sales API exists, so this simply re-exports the
// scraper. Kept as its own file so services never import
// vijaysales.scraper.js directly - same reasoning as adapters/lenskart/index.js.

'use strict';

module.exports = require('./vijaysales.scraper');
