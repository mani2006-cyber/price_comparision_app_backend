// src/adapters/myntra/index.js
//
// No official Myntra API exists, so this simply re-exports the scraper.
// Still kept as its own file (not imported directly by services) so
// that IF an official API is added later, this is the only file that
// changes - services always import from adapters/myntra, never from
// myntra.scraper.js directly.

'use strict';

module.exports = require('./myntra.scraper');