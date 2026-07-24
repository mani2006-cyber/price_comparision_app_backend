// fetch-and-save.js
//
// Fetches the HTML for a list of (site, query, url) entries and saves
// each page to disk using the Node.js `fs` module.
//
// Usage:
//   npm install axios
//   node fetch-and-save.js
//
// Output:
//   ./output/<site>.html        - one HTML file per site
//   ./output/manifest.json      - what was fetched, when, and the result

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ── 1. List of sites/queries/urls to fetch ──────────────────────────
// Add, remove, or edit entries here. `url` can be a search-results page
// or a direct product page - whatever you want the raw HTML for.
const TARGETS = [{
        site: 'amazon',
        query: 'wireless bluetooth headphones',
        url: 'https://www.amazon.in/Sony-Bluetooth-Headphones-Multipoint-Connectivity/dp/B0BS1RT9S2',
    },
    {
        site: 'flipkart',
        query: 'wireless bluetooth headphones',
        url: 'https://www.flipkart.com/tws-flipkart-tb-p47-wireless-bluetooth-headphones-hd-sound-bass-mic-headset/p/itm0584d1b69944e',
    },
    {
        site: 'ebay',
        query: 'wireless bluetooth headphones',
        url: 'https://www.ebay.com/itm/267320613152',
    },
    {
        site: 'walmart',
        query: 'wireless bluetooth headphones',
        url: 'https://www.walmart.com/ip/ONN-BT-ON-EAR-BLK/368708375',
    },
    {
        site: 'bestbuy',
        query: 'wireless bluetooth headphones',
        url: 'https://www.bestbuy.com/product/skullcandy-crusher-1080-over-the-ear-noise-canceling-wireless-bluetooth-headphones-with-sound-by-bose-black/J3GWL57W8L/sku/6675674',
    },
    {
        site: 'target',
        query: 'wireless bluetooth headphones',
        url: 'https://www.target.com/p/wireless-bluetooth-headphones-5-1-40-hrs-playtime-wireless-over-ear-headphones-4-mics-enc-noise-cancelling-for-clear-calls/-/A-1007342108',
    },
    {
        site: 'snapdeal',
        query: 'wireless bluetooth headphones',
        url: 'https://www.snapdeal.com/product/airphone-wireless-overear-headphones-prolevel/677292663198',
    },
    {
        site: 'meesho',
        query: 'wireless bluetooth headphones',
        url: 'https://www.meesho.com/boat-m19-tws-bluetooth-51-wireless-earbuds-touch-waterproof-ipx7-led-digital-display-bluetooth-headset-black-true-wireless-bluetooth-headphones-earphones-black/p/3dna5b',
    },
    {
        site: 'newegg',
        query: 'wireless bluetooth headphones',
        url: 'https://www.newegg.com/p/0TH-0741-000V6',
    },
    {
        site: 'etsy',
        query: 'bluetooth headphone case',
        url: 'https://www.etsy.com/market/bluetooth_headphone_case',
    },
];

// ── 2. Config ────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(__dirname, 'output');
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
    return Math.min(BASE_DELAY_MS * 2 ** attempt + Math.random() * 400, 10000);
}

function getHeaders() {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    };
}

// ── 3. Fetch one URL, retrying on failure ───────────────────────────
async function fetchHtml(url) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await axios.get(url, {
                headers: getHeaders(),
                timeout: 20000,
                maxRedirects: 5,
                validateStatus: (status) => status >= 200 && status < 500,
            });

            if (response.status >= 200 && response.status < 300) {
                return { html: response.data, status: response.status };
            }

            // 4xx/429/503 - retry with backoff
            if (attempt < MAX_RETRIES) {
                await sleep(backoffDelay(attempt));
                continue;
            }
            return { html: response.data, status: response.status };

        } catch (err) {
            lastErr = err;
            if (attempt < MAX_RETRIES) {
                await sleep(backoffDelay(attempt));
                continue;
            }
        }
    }
    throw lastErr || new Error('fetchHtml failed for unknown reason: ' + url);
}

// ── 4. Save one page to disk using fs ───────────────────────────────
function saveHtmlFile(site, html) {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    const filePath = path.join(OUTPUT_DIR, `${site}.html`);
    fs.writeFileSync(filePath, html, 'utf8');
    return filePath;
}

// ── 5. Run all targets sequentially (polite pacing between sites) ──
async function run() {
    const manifest = [];

    for (const target of TARGETS) {
        const { site, query, url } = target;
        console.log(`[${site}] fetching: ${url}`);

        try {
            const { html, status } = await fetchHtml(url);
            const filePath = saveHtmlFile(site, html);

            console.log(`[${site}] saved -> ${filePath} (status ${status}, ${html.length} bytes)`);
            manifest.push({
                site,
                query,
                url,
                status,
                savedTo: filePath,
                bytes: html.length,
                fetchedAt: new Date().toISOString(),
                ok: true,
            });

        } catch (err) {
            console.error(`[${site}] FAILED: ${err.message}`);
            manifest.push({
                site,
                query,
                url,
                error: err.message,
                fetchedAt: new Date().toISOString(),
                ok: false,
            });
        }

        // Be polite: small delay between different sites so we're not
        // hammering multiple hosts back-to-back in a tight loop.
        await sleep(1500);
    }

    const manifestPath = path.join(OUTPUT_DIR, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`\nDone. Manifest written to ${manifestPath}`);
    console.log(`Success: ${manifest.filter((m) => m.ok).length}/${manifest.length}`);
}

run().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});