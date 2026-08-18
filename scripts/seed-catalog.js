// scripts/seed-catalog.js
//
// Seeds the admin-curated catalog (AdminProduct) that backs
// GET /api/categories - see catalog-seed-data.js for the entries and why
// they look the way they do.
//
//   npm run seed:catalog              add anything missing, leave the rest alone
//   npm run seed:catalog -- --reset   delete the whole catalog first
//
// Talks to MongoDB directly through adminProduct.repository rather than
// POSTing to /api/admin/products, for two reasons: the global apiLimiter
// would reject most of a 90-entry run (RATE_LIMIT_MAX is per-IP per
// minute), and a seed is a server-side operation - it shouldn't need the
// admin HTTP key to exist at all. Going through the repository rather
// than the model directly still gets the slug hook and, importantly, the
// GET /api/categories cache invalidation on every write, so a freshly
// seeded catalog shows up immediately instead of after the category
// cache TTL expires.
//
// Idempotent: an entry is matched on (title, category), so re-running
// adds only what's genuinely new and never duplicates.

'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../src/config/db');
const { disconnectRedis } = require('../src/config/redis');
const AdminProduct = require('../src/models/AdminProduct.model');
const adminProductRepository = require('../src/repositories/adminProduct.repository');
const { CATALOG_SEED } = require('./catalog-seed-data');

async function main() {
    const reset = process.argv.includes('--reset');

    await connectDB();
    console.log('Connected to ' + mongoose.connection.name);

    if (reset) {
        const { deletedCount } = await AdminProduct.deleteMany({});
        console.log('--reset: removed ' + deletedCount + ' existing catalog entries');
    }

    // One query for everything already there, rather than an existence
    // check per entry - 90 sequential round trips for data that fits
    // comfortably in memory is pure waste.
    const existing = await AdminProduct.find({}, 'title category').lean();
    const seen = new Set(existing.map(function(p) {
        return p.title.trim().toLowerCase() + ' ' + p.category.trim().toLowerCase();
    }));

    let created = 0;
    let skipped = 0;
    const perCategory = new Map();

    for (const entry of CATALOG_SEED) {
        const key = entry.title.trim().toLowerCase() + ' ' + entry.category.trim().toLowerCase();
        if (seen.has(key)) {
            skipped++;
            continue;
        }

        await adminProductRepository.create({
            title: entry.title,
            description: entry.description || null,
            category: entry.category,
            price: entry.price,
            image: entry.image || null,
            status: entry.status || 'active',
        });

        seen.add(key);
        created++;
        perCategory.set(entry.category, (perCategory.get(entry.category) || 0) + 1);
    }

    console.log('');
    console.log('Created ' + created + ', skipped ' + skipped + ' (already present)');
    if (perCategory.size > 0) {
        console.log('');
        for (const [category, count] of perCategory) {
            console.log('  ' + count + '  ' + category);
        }
    }

    const totals = await adminProductRepository.findDistinctCategories();
    const totalProducts = totals.reduce(function(sum, c) { return sum + c.count; }, 0);
    console.log('');
    console.log('Catalog now holds ' + totalProducts + ' active products across ' + totals.length + ' categories.');

    await shutdown();
}

// adminProduct.repository pulls in utils/cache, which opens the shared
// ioredis client on require - an open Redis socket keeps the event loop
// alive forever, so a script that only closed Mongo would print its
// results and then hang instead of exiting. Both have to come down.
async function shutdown() {
    try { await disconnectDB(); } catch { /* already down */ }
    try { await disconnectRedis(); } catch { /* already down, or disabled */ }
}

main().catch(async function(err) {
    console.error('Seed failed:', err.message);
    await shutdown();
    process.exit(1);
});
