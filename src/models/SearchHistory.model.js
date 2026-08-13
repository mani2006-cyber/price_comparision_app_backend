// src/models/SearchHistory.model.js
//
// One row per DISTINCT (userId, query, platform) combination for a
// logged-in user - NOT one row per search event. Repeating an identical
// search updates the existing row (bumps lastSearchedAt, increments
// searchCount) rather than creating a duplicate, so a user's history
// behaves like browser history: repeat a search, it jumps back to the
// top instead of cluttering the list with copies.
//
// Guest searches are never recorded - enforced by the service layer,
// not this model (a userId is simply required here). Old entries beyond
// a retention cap are pruned by the repository layer after each upsert.

'use strict';

const mongoose = require('mongoose');

const searchHistorySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    query: {
        type: String,
        required: true,
        trim: true,
        lowercase: true, // "iPhone" and "iphone" should merge into the same row
    },
    // Optional - which marketplace this search targeted, if a specific
    // one was requested. Null means "searched across all marketplaces".
    // Part of the uniqueness key: searching "iphone" globally and
    // searching "iphone" scoped to amazon are treated as distinct.
    platform: {
        type: String,
        default: null,
    },
    // Result count from the MOST RECENT time this exact search ran -
    // intentionally overwritten on each repeat, not summed.
    resultCount: {
        type: Number,
        default: 0,
    },
    // How many times this exact (userId, query, platform) has been
    // searched. Starts at 1 on first creation, incremented on repeat.
    searchCount: {
        type: Number,
        default: 1,
    },
    // What "most recent" actually sorts by - separate from createdAt,
    // which stays fixed at whenever this row was FIRST created.
    lastSearchedAt: {
        type: Date,
        default: Date.now,
    },
}, {
    timestamps: true, // createdAt = when first searched; updatedAt tracks Mongoose's own bookkeeping
});

// The actual uniqueness rule now: one row per user+query+platform combo.
// This is what the upsert in the repository layer relies on.
searchHistorySchema.index({ userId: 1, query: 1, platform: 1 }, { unique: true });

// Matches the real query pattern: this user's searches, most recently
// searched (not just most recently created) first.
searchHistorySchema.index({ userId: 1, lastSearchedAt: -1 });

const SearchHistory = mongoose.model('SearchHistory', searchHistorySchema);

module.exports = SearchHistory;