#!/usr/bin/env node
/**
 * ingest.js — nightly bulk pull of active sale listings into listings.json
 *
 * WHY BULK, NOT PER-USER:
 * RentCast bills per request. If the site called the API on every visitor
 * search, 400 daily users × 8 searches = ~96,000 requests/month. On the
 * Growth plan that's 5,000 included and 91,000 overage at $0.03 = ~$2,700/mo.
 *
 * Pulling the whole target market once a night is ~10-15 requests/day,
 * roughly 400/month, which sits inside the $74 Foundation plan. Visitors
 * then search a static JSON file your host serves for free.
 *
 * You also NEED the full market locally anyway — peer-group baselines are
 * medians across all comparable homes, not just the ones a user filtered to.
 *
 * USAGE:
 *   RENTCAST_API_KEY=xxx node ingest.js
 *
 * Run it on a schedule (GitHub Actions cron, Vercel cron, or plain crontab)
 * and commit or upload the resulting listings.json.
 */

const fs = require("fs");

const API_KEY = process.env.RENTCAST_API_KEY;
if (!API_KEY) {
  console.error("Missing RENTCAST_API_KEY environment variable.");
  process.exit(1);
}

/* ---------------------------------------------------------------
   TARGET MARKET
   Keep this tight. Every city added costs requests every night.
   --------------------------------------------------------------- */
const MARKET = {
  state: "TN",
  cities: [
    "Brentwood",
    "Franklin",
    "Nolensville",
    "Thompson's Station",
    "Spring Hill",
    "College Grove",
    "Arrington",
    "Fairview"
  ],
  propertyTypes: ["Single Family", "Townhouse", "Condo"],
  minSqft: 800,          // drop land parcels and data errors
  minPrice: 100000
};

const BASE = "https://api.rentcast.io/v1/listings/sale";
const PAGE = 500;        // API max per response
const MAX_PAGES = 6;     // hard stop so a bad query can't run up a bill

let requestCount = 0;

async function fetchCity(city) {
  const collected = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(BASE);
    url.searchParams.set("city", city);
    url.searchParams.set("state", MARKET.state);
    url.searchParams.set("status", "Active");
    url.searchParams.set("limit", String(PAGE));
    url.searchParams.set("offset", String(page * PAGE));

    const res = await fetch(url, { headers: { "X-Api-Key": API_KEY } });
    requestCount++;

    if (!res.ok) {
      console.error(`  ${city}: HTTP ${res.status} — ${await res.text()}`);
      break;
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    collected.push(...batch);
    if (batch.length < PAGE) break;   // last page
  }

  console.log(`  ${city}: ${collected.length} listings`);
  return collected;
}

/* ---------------------------------------------------------------
   NORMALISE
   RentCast shape -> the shape the front end expects.
   lotSize arrives in square feet; the UI shows acres.
   --------------------------------------------------------------- */
function normalise(l) {
  return {
    id: l.id,
    address: l.addressLine1 || l.formattedAddress,
    city: l.city,
    county: l.county,
    zip: l.zipCode,
    lat: l.latitude,
    lng: l.longitude,
    propertyType: l.propertyType,
    price: l.price,
    sqft: l.squareFootage,
    beds: l.bedrooms,
    baths: l.bathrooms,
    yearBuilt: l.yearBuilt,
    lotAcres: l.lotSize ? Math.round((l.lotSize / 43560) * 100) / 100 : null,
    dom: l.daysOnMarket,
    hoaMonthly: l.hoa?.fee || 0,
    // New construction is priced off a builder base and usually excludes
    // lot premium and options. It will fake its way to the top of any
    // $/sqft ranking, so the UI segments it out.
    isNewConstruction: l.listingType === "New Construction",
    listedDate: l.listedDate,
    mlsNumber: l.mlsNumber || null
  };
}

function usable(p) {
  return (
    p.price >= MARKET.minPrice &&
    p.sqft >= MARKET.minSqft &&
    p.beds > 0 &&
    MARKET.propertyTypes.includes(p.propertyType)
  );
}

/* ---------------------------------------------------------------
   OUTLIER GUARD
   Bad square-footage records produce absurd $/sqft values that would
   distort every median. Trim the extreme tails before publishing.
   --------------------------------------------------------------- */
function trimOutliers(rows) {
  const ppsf = rows.map(r => r.price / r.sqft).sort((a, b) => a - b);
  const q = p => ppsf[Math.floor(ppsf.length * p)];
  const lo = q(0.01), hi = q(0.99);
  const kept = rows.filter(r => {
    const v = r.price / r.sqft;
    return v >= lo && v <= hi;
  });
  console.log(`Trimmed ${rows.length - kept.length} outliers outside $${Math.round(lo)}–$${Math.round(hi)}/sqft`);
  return kept;
}

async function main() {
  console.log(`Pulling active listings for ${MARKET.cities.length} cities...`);

  const raw = [];
  for (const city of MARKET.cities) {
    raw.push(...(await fetchCity(city)));
  }

  const seen = new Set();
  const rows = raw
    .map(normalise)
    .filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return usable(p);
    });

  const clean = trimOutliers(rows);

  const payload = {
    generatedAt: new Date().toISOString(),
    market: MARKET.cities.join(", ") + ", " + MARKET.state,
    count: clean.length,
    listings: clean
  };

  fs.writeFileSync("listings.json", JSON.stringify(payload));

  console.log(`\nWrote listings.json — ${clean.length} listings`);
  console.log(`API requests used: ${requestCount}`);
  console.log(`Projected monthly: ~${requestCount * 30} requests`);
}

main().catch(e => { console.error(e); process.exit(1); });
