# Adding a marketplace adapter

The recipe for marketplace #9 onward. `src/adapters/vijaysales/`,
`src/adapters/poorvika/`, and `src/adapters/nykaa/` are the worked
examples - every step below points at the file in one of them that
demonstrates the pattern.

**Read Step 5 twice.** Everything else here is normal feature work; Step
5 is the one that fails silently - the adapter runs, scrapes real data,
returns it, and then MongoDB quietly throws it away with no error
surfaced to the API caller. That exact incident happened while building
the three adapters above (see "The incident" at the bottom) and cost far
longer to diagnose than every other step in this doc combined.

## Files you will touch, in order

| # | File | What changes |
|---|---|---|
| 1 | `src/adapters/<marketplace>/<marketplace>.scraper.js` | New - the actual scraping logic |
| 2 | `src/adapters/<marketplace>/index.js` | New - re-exports the scraper (or mode-switches API/scraper) |
| 3 | `src/adapters/index.js` | Register the adapter + URL detection |
| 4 | `src/adapters/provider.interface.js` | Add to `VALID_MARKETPLACES` |
| 5 | **`src/models/Product.model.js`** | **Add to the `MARKETPLACES` enum - see the warning above** |
| 6 | `src/services/compare.service.js` | Cosmetic - update a hardcoded fallback string (low priority) |
| 7 | `tests/unit/adapters/<marketplace>.scraper.test.js` | New - unit tests, axios mocked |
| 8 | `tests/unit/adapters/index.test.js` | Extend - registry/detection coverage |
| 9 | `tests/integration/models/Product.test.js` | Extend - enum regression test |

## Step 1: research the real site BEFORE writing selectors

Do not guess at markup. Fetch a real search-results page and a real
product page (`curl` or a throwaway `axios.get` script) and look for,
in this priority order:

1. **JSON-LD** - `<script type="application/ld+json">` with
   `"@type": "Product"`. Cheapest, most stable source when present.
   Covers title/brand/images/price/availability on most modern sites.
   See `poorvika.scraper.js` and `vijaysales.scraper.js`.
2. **A framework's embedded state blob** - `__NEXT_DATA__` (Next.js),
   `__PRELOADED_STATE__`, or similar. Usually the only source for
   fields JSON-LD doesn't carry (MRP, rating, seller, variants - Offer/
   AggregateOffer has no "original price" concept). See
   `nykaa.scraper.js`'s `extractPreloadedProduct`.
3. **Plain HTML selectors** - last resort, most fragile. If the site is
   server-rendered with no structured data at all, you're stuck here;
   keep selectors keyed off structural signals (a stable URL pattern, a
   `data-*` attribute) rather than hashed CSS-module class names, which
   change on every deploy (see `poorvika.scraper.js`'s
   `findCardWithImage` for why - the nearest ancestor `<div>` was the
   WRONG element to search for an image on that site's real markup).

Also check the search endpoint specifically - it is very often NOT the
same as what a browser's search box hits. Real examples found this
session: Nykaa's actual search-RESULTS page is robots.txt-disallowed,
so the adapter calls its autocomplete endpoint instead
(`/gludo/searchSuggestions`); Vijay Sales' search page is entirely
client-rendered with zero server-side product data, so the adapter
calls the third-party search backend (Unbxd) its frontend itself uses.
**Verify this against a real fetch, don't assume the obvious URL works.**

If `src/scraper/` (a separate, standalone research project in this
repo) already has fixture-backed findings for the marketplace you're
adding, read `src/scraper/src/connectors/<marketplace>/` and
`src/scraper/docs/` first - the three existing adapters were ported
from exactly that research rather than re-derived from scratch.

## Step 2: folder shape

```
src/adapters/<marketplace>/
  index.js               - re-exports the scraper (see index.js pattern below)
  <marketplace>.scraper.js  - the actual implementation
```

If the marketplace has a real official API in addition to a scraper
(only `amazon` and `flipkart` do today), follow their `index.js`
pattern instead: mode-switch between `<marketplace>.api.js` and
`<marketplace>.scraper.js` based on `config.providerModes.<marketplace>`
(`'scraper' | 'api' | 'auto'`), with `'auto'` trying the API first and
falling back to the scraper on failure. Scraper-only marketplaces
(everything else, including all three worked examples) just do:

```js
// src/adapters/<marketplace>/index.js
'use strict';
module.exports = require('./<marketplace>.scraper');
```

## Step 3: the scraper file's contract

Every adapter (scraper or API) must export exactly two async functions
- this is enforced by `src/adapters/provider.interface.js`, read its
header comment in full before writing anything:

```js
async function searchByQuery(query, options) // -> Promise<Array<ProviderProduct>>
async function searchByLink(url)             // -> Promise<ProviderProduct | null>
```

Every object you return MUST go through `withDefaults()` then
`validateProviderProduct()` / `validateProviderProductList()` from
`provider.interface.js` - never construct the raw response object and
return it directly. This is what turns a malformed adapter into a loud,
immediate `ProviderContractError` instead of a confusing failure three
layers away in `product.repository.js`.

Required fields: `marketplace`, `externalId` (a STABLE id - the site's
own SKU/product-id, never something derived from a mutable slug),
`title`, `currentPrice`, `rawUrl`, `fetchedVia` (`'scraper'` or
`'api'`). Everything else is optional and defaulted by `withDefaults()`.

If a field genuinely has no reliable source on this site (see
`poorvika.scraper.js`'s `availability: 'unknown'` - JSON-LD's own claim
was confirmed wrong on a real out-of-stock product, and no other static
signal was found), report the honest `'unknown'`/`null`, never guess.

## Step 4: `searchByQuery` when the search endpoint has no price

`currentPrice` is required, but some search/autocomplete endpoints
don't carry it (Nykaa's doesn't). In that case, fetch each candidate's
product page in parallel and best-effort - a candidate whose page fails
to parse is dropped, not fatal to the whole search. See
`nykaa.scraper.js`'s `searchByQuery` (`Promise.allSettled`, not
`Promise.all`) for the pattern.

## Step 5: wire the adapter into the registry (2 files, easy to think you're done after this)

**`src/adapters/index.js`:**
```js
const <marketplace> = require('./<marketplace>');
// ...
const MARKETPLACE_REGISTRY = {
    // ...existing entries,
    <marketplace>,
};
```
And add a line to `detectMarketplaceFromUrl()`:
```js
if (lower.indexOf('<marketplace-domain>.') !== -1) return '<marketplace>';
```

**`src/adapters/provider.interface.js`:** add the new slug to
`VALID_MARKETPLACES` (and update the shape comment at the top of the
file listing valid `marketplace` values - it's documentation, but
outdated documentation here is exactly what caused the Step 6 miss last
time).

At this point `npm run dev` + a manual search will show your new
marketplace's results in the raw adapter output... but they will
**silently vanish** before reaching the API response, because of Step 6.

## Step 6 (THE STEP): `src/models/Product.model.js`

This file has **its own, separate** `MARKETPLACES` enum array, used by
Mongoose to validate every document before it's saved:

```js
const MARKETPLACES = ['amazon', 'flipkart', 'myntra', 'ajio', 'lenskart', /* add yours here */];
```

`provider.interface.js`'s own header comment literally says `//
ProviderProduct shape (matches Product.model.js exactly)` - it is
telling you this file has to match, and it is easy to update one and
genuinely forget the other exists, because they don't reference each
other in code and nothing fails at requiring time.

**What happens if you skip this:** `product.service.js`'s
`searchAndPersist()` calls `productRepository.upsertFromProviderData()`
for every result. That call throws a Mongoose `ValidationError`
(`marketplace: 'yourmarketplace' is not a valid enum value`).
`upsertSafely()` in `product.service.js` catches that error **and logs
it**, then returns `null` for that item - which gets filtered out of
the persisted results array. The HTTP response comes back `200 OK` with
real results from every OTHER marketplace, and yours is just... absent.
No 4xx, no 5xx, no error in the JSON body. The only trace is a
server-log line:

```
[ERROR] Failed to persist a search result - skipping this item { marketplace: 'poorvika', message: "Product validation failed: marketplace: `poorvika` is not a valid enum value for path `marketplace`." }
```

If your new marketplace's results aren't showing up in `/api/search`
and the adapter's own logs show it fetched real results, **this is the
first thing to check** - `grep -i "not a valid enum value" server.log`.

## Step 7 (cosmetic, do it anyway): `src/services/compare.service.js`

`compareByUrl()` has a hardcoded fallback marketplace-list string used
only if `adapters.getActiveMarketplaces()` itself throws (a defensive
edge case, not the normal path):

```js
let activeList = 'amazon, flipkart, myntra, lenskart, nykaa, poorvika, vijaysales';
```

Low priority - the real list is fetched dynamically first - but keep it
current since it's the message a user actually sees if that fallback
ever triggers.

## Step 8: tests

Write these three, in this order:

1. **`tests/unit/adapters/<marketplace>.scraper.test.js`** - `jest.mock('axios')`,
   feed synthetic HTML/JSON fixtures matching what you found in Step 1,
   assert the parsed `ProviderProduct` shape. Cover: a normal
   search-result card, a product page with every optional field present,
   a product page missing optional fields (falls back to `null`/
   `'unknown'` correctly), and a page with no usable data at all
   (`searchByLink` returns `null`, doesn't throw). See
   `tests/unit/adapters/poorvika.scraper.test.js` for the fullest
   example, including two real regression tests for bugs caught by
   testing against the live site (a rating badge glued onto a price
   string, an image living on a wider DOM ancestor than expected) -
   write tests like those, not just happy-path ones.

2. **`tests/unit/adapters/index.test.js`** - add your marketplace to the
   `ALL_MARKETPLACES` array and the `detectMarketplaceFromUrl` cases
   table. This is what would have caught a Step 5 mistake (forgetting
   the registry entry or URL-detection line) - it would NOT have caught
   the Step 6 mistake, which is exactly why the next test exists.

3. **`tests/integration/models/Product.test.js`** - add your marketplace
   slug to the `NEW_MARKETPLACES` array in the "Product model -
   marketplace enum" block. This is the test that directly pins Step 6 -
   it creates a real `Product` document with your marketplace and
   asserts Mongoose accepts it. **This is the one test in this whole
   list that would have caught the actual incident** - run it
   specifically after Step 6 as your own sanity check:
   ```
   npx cross-env NODE_ENV=test jest tests/integration/models/Product.test.js -t "marketplace enum"
   ```

## Step 9: verify against the real site once

Unit tests with mocked HTML prove your PARSING logic is correct given
the fixtures you wrote - they cannot prove the fixtures themselves match
reality. Before calling the adapter done, run it against the live site
directly:

```js
node -e "
const adapter = require('./src/adapters/<marketplace>');
adapter.searchByQuery('<a real query>').then(r => {
  console.log('results:', r.length);
  console.log(JSON.stringify(r.slice(0,2), null, 2));
}).catch(e => console.log('ERROR:', e.message));
"
```

Then `searchByLink` against one real product URL from those results.
Check prices/images/titles look sane by eye - a parser can produce a
value that passes every type check in `provider.interface.js` and is
still wrong (this session's real example: a price of `16999051` for a
₹1,69,990 phone - a valid positive number, wrong by three orders of
magnitude, caused by a rating badge's digits getting glued onto the
price text with no separator in the real markup).

If live results look right, start the real server and hit `/api/search`
for real - this is what actually catches a Step 6 miss, since the unit
tests mock persistence away:

```
npm start
curl "http://localhost:<PORT>/api/search?q=<query>"
```
Check the response's `products` array actually contains your
marketplace, not just that the request returned `200`.

## The incident (why Step 6 gets its own heading)

While adding nykaa/poorvika/vijaysales, every adapter was built,
unit-tested, and verified against live sites successfully. Steps 1-5
above were all done correctly. Step 6 was missed - `provider.interface.js`
was updated but the identically-shaped enum in `Product.model.js` was
not. The result: `/api/search?q=laptop` returned `200 OK` with real
results from `flipkart`/`myntra` and **silently zero** from the three
new marketplaces, even though their own adapter logs showed
`"Poorvika scraper search finished { count: 8 }"` moments earlier. It
took a full server run + reading raw server logs line-by-line to find
`"marketplace: poorvika is not a valid enum value"` buried among normal
request logs. A single `grep` for that phrase, or the regression test
in Step 8.3, finds it in seconds - hence this document.
