const fs = require("fs");

const PRICES_FILE = "./static/prices/latest.json";

const SKINPORT_URL = "https://api.skinport.com/v1/items?app_id=570&currency=USD&tradable=0";
const DMARKET_URL = "https://api.dmarket.com/marketplace-api/v1/aggregated-prices";
// DMarket's id of Dota 2
const DMARKET_GAME = "9a92";
const DMARKET_PAGE = 1000;
const DMARKET_MAX_PAGES = 100;

const REQUEST_DELAY = 1000;
const RETRY_WAITS = [10, 30, 60, 120].map((seconds) => seconds * 1000);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => Math.round(value * 100) / 100;

// latest.json: { "<market hash name>": { price, dmarket?: {...}, skinport?: {...} } }
// price - the lowest offer across the markets, each market keeps its lowest offer and count
const SOURCES = {
  dmarket: getDmarketOffers,
  skinport: getSkinportOffers,
};

run().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);

async function run() {
  const old = loadJSON(PRICES_FILE, {});
  const prices = {};
  let failed = false;

  for (const [source, getOffers] of Object.entries(SOURCES)) {
    let offers;
    try {
      offers = await getOffers();
      console.log(`${source}: ${offers.size} items on sale`);
    } catch (error) {
      // Keep what was collected last time rather than drop the market's prices
      console.error(`${source} failed, keeping its old prices: ${error.message}`);
      failed = true;
      offers = new Map();
      for (const [name, entry] of Object.entries(old)) {
        if (entry[source]) offers.set(name, entry[source]);
      }
    }

    for (const [name, offer] of offers) {
      (prices[name] ??= {})[source] = offer;
    }
  }

  for (const entry of Object.values(prices)) {
    entry.price = Math.min(...Object.keys(SOURCES).map((source) => entry[source]?.price ?? Infinity));
  }

  savePrices(prices);
  console.log(`${Object.keys(prices).length} items with a price.`);
  return failed ? 1 : 0;
}

async function request(url, options) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res.json();

    const retry = res.status == 429 || res.status >= 500;
    if (!retry || attempt >= RETRY_WAITS.length) {
      throw new Error(`HTTP ${res.status} ${url}: ${(await res.text()).slice(0, 200)}`);
    }
    console.log(`HTTP ${res.status}, waiting ${RETRY_WAITS[attempt] / 1000} s...`);
    await delay(RETRY_WAITS[attempt]);
  }
}

// All items of the game in one answer; Skinport wants the answer brotli compressed
async function getSkinportOffers() {
  const items = await request(SKINPORT_URL, { headers: { "Accept-Encoding": "br" } });
  const offers = new Map();

  for (const item of items) {
    if (item.quantity > 0 && item.min_price) {
      offers.set(item.market_hash_name, { price: round(item.min_price), offers: item.quantity });
    }
  }
  return offers;
}

// A page of up to 1000 titles per request, amounts in cents
async function getDmarketOffers() {
  const offers = new Map();
  let cursor = "";

  for (let page = 0; page < DMARKET_MAX_PAGES; page++) {
    const body = { filter: { game: DMARKET_GAME }, limit: String(DMARKET_PAGE) };
    if (cursor) body.cursor = cursor;

    const data = await request(DMARKET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    for (const item of data.aggregatedPrices) {
      const count = parseInt(item.offerCount);
      const amount = parseInt(item.offerBestPrice?.Amount);
      if (count > 0 && amount > 0) {
        offers.set(item.title, { price: amount / 100, offers: count });
      }
    }

    cursor = data.nextCursor;
    if (!cursor) return offers;
    await delay(REQUEST_DELAY);
  }
  throw new Error(`more than ${DMARKET_MAX_PAGES} pages`);
}

function loadJSON(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

// One item per line so that git diffs stay small
function savePrices(prices) {
  const lines = Object.keys(prices)
    .sort()
    .map((name) => {
      const { price, ...markets } = prices[name];
      return `${JSON.stringify(name)}:${JSON.stringify({ price, ...markets })}`;
    });
  fs.mkdirSync("./static/prices", { recursive: true });
  fs.writeFileSync(PRICES_FILE, `{\n${lines.join(",\n")}\n}\n`);
}
