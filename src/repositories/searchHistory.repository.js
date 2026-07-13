// src/repositories/searchHistory.repository.js
//
// All direct Mongoose access for the SearchHistory collection.
// recordSearch trims each user's history down to a retention cap
// immediately after insert, so this collection stays bounded per user
// instead of growing forever (the old codebase only ever limited at
// READ time, meaning the underlying collection grew unboundedly).

'use strict';

const SearchHistory = require('../models/SearchHistory.model');

const DEFAULT_RETENTION_LIMIT = 20;

// ── Write ────────────────────────────────────────────────────────────

// Records a search, then trims this user's history back down to
// `retentionLimit` most-recent rows. The trim cost is paid incrementally,
// one user at a time, exactly when they add a new search - no separate
// cleanup job needed.
async function recordSearch(userId, query, resultCount, platform, retentionLimit) {
    const normalizedQuery = query.trim().toLowerCase();
    const normalizedPlatform = platform || null;

    const filter = { userId, query: normalizedQuery, platform: normalizedPlatform };
    const updateOps = {
        $set: {
            resultCount: resultCount || 0,
            lastSearchedAt: new Date(),
        },
        $inc: { searchCount: 1 },
        $setOnInsert: { userId, query: normalizedQuery, platform: normalizedPlatform },
    };

    let updated;
    try {
        updated = await SearchHistory.findOneAndUpdate(filter, updateOps, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
        });
    } catch (err) {

        if (err.code === 11000) {
            updated = await SearchHistory.findOneAndUpdate(filter, updateOps, { new: true });
        } else {
            throw err;
        }
    }

    await trimToLimit(userId, retentionLimit || DEFAULT_RETENTION_LIMIT);

    return updated;
}
// Deletes the oldest rows beyond `limit` for a given user. Exposed
// separately (not just inlined into recordSearch) so it can be reused,
// e.g. by an admin cleanup task, without duplicating this query.
async function trimToLimit(userId, limit) {
    // Find the ids of everything BEYOND the most recent `limit` rows.
    const excessRows = await SearchHistory.find({ userId })
        .sort({ createdAt: -1 })
        .skip(limit)
        .select('_id');

    if (excessRows.length === 0) {
        return 0;
    }

    const excessIds = excessRows.map(function(row) {
        return row._id;
    });

    const result = await SearchHistory.deleteMany({ _id: { $in: excessIds } });
    return result.deletedCount;
}

// ── Reads ────────────────────────────────────────────────────────────

async function findByUser(userId, limit) {
    return SearchHistory.find({ userId })
        .sort({ createdAt: -1 })
        .limit(limit || DEFAULT_RETENTION_LIMIT);
}

// ── Delete ───────────────────────────────────────────────────────────

// Ownership-scoped, same pattern as wishlist/alert repositories.
async function removeByIdForUser(entryId, userId) {
    return SearchHistory.deleteOne({ _id: entryId, userId });
}

module.exports = {
    recordSearch,
    trimToLimit,
    findByUser,
    removeByIdForUser,
    DEFAULT_RETENTION_LIMIT,
};