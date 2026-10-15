const SteamCommunity = require("steamcommunity");
const fs = require("fs");
const crypto = require("crypto");

const dirPrices = "./static/prices";
const dirPricehistory = "./static/pricehistory";
const PRICES_FILE = `${dirPrices}/latest.json`;
const STATE_FILE = "state.json";

const ITEMS_URL =
  "https://raw.githubusercontent.com/S1nuxoff/dota2-file-tracker/main/static/items_game.json";
const MARKET_BASE_URL = "https://steamcommunity.com/market";

// Item types that are never sold on the market
const SKIP_PREFABS = new Set([
  "default_item",
  "showcase_decoration",
  "courier_wearable",
  "versus_screen",
]);

const START_TIME = Date.now();
// GitHub kills a job after 6 hours, leave time for the commit
const MAX_DURATION = 5.5 * 3600 * 1000;
// Steam allows about 20 market requests per minute
const REQUEST_DELAY = 3000;
const RATE_LIMIT_WAITS = [2, 5, 10].map((minutes) => minutes * 60 * 1000);
const MAX_ERRORS_IN_ROW = 10;
const MAX_ITEM_ERRORS = 3;
const NO_SALES_RECHECK = 30 * 24 * 3600 * 1000;
const SAVE_EVERY = 25;

// state.json: { "<market hash name>": [checkedAt (unix seconds), status] }
// status: 1 has sales, 0 no sales, negative - number of failed requests
const SALES = 1;
const NO_SALES = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const historyPath = (name) =>
  `${dirPricehistory}/${crypto.createHash("sha1").update(name).digest("hex")}.json`;

if (process.argv.length != 4) {
  console.error(`Usage: node index.js <USERNAME> <PASSWORD>`);
  process.exit(1);
}

fs.mkdirSync(dirPrices, { recursive: true });
fs.mkdirSync(dirPricehistory, { recursive: true });

const community = new SteamCommunity();

console.log("Logging into Steam community....");

community.login(
  {
    accountName: process.argv[2],
    password: process.argv[3],
    disableMobile: true,
  },
  async (err) => {
    if (err) {
      console.error("Login failed:", err.message);
      process.exit(1);
    }

    try {
      process.exit(await run());
    } catch (error) {
      console.error("An error occurred while processing items:", error);
      process.exit(1);
    }
  }
);

async function run() {
  console.log("Loading items...");
  const names = await getMarketableItemNames();
  const state = loadState();
  const prices = loadJSON(PRICES_FILE, {});
  const queue = buildQueue(names, state);

  console.log(`${names.length} items, ${queue.length} to check in this run.`);

  const ok = await processItems(queue, state, prices);

  saveState(state);
  savePrices(prices);
  return ok ? 0 : 1;
}

async function getMarketableItemNames() {
  const res = await fetch(ITEMS_URL);
  if (!res.ok) {
    throw new Error(`Could not load items: HTTP ${res.status} ${ITEMS_URL}`);
  }

  const items = Object.values((await res.json()).items_game.items).filter(
    (item) => item.name && item.prefab && !SKIP_PREFABS.has(item.prefab)
  );
  items.sort((a, b) => a.prefab.localeCompare(b.prefab));
  return [...new Set(items.map((item) => item.name))];
}

// Never checked items go first (those with an old price history before the rest),
// then the ones checked longest ago. Items without sales wait NO_SALES_RECHECK.
function buildQueue(names, state) {
  const now = Date.now();
  const queue = [];

  for (const name of names) {
    const entry = state[name];
    if (!entry) {
      queue.push({ name, group: fs.existsSync(historyPath(name)) ? 0 : 1, checkedAt: 0 });
      continue;
    }

    const [checkedAt, status] = entry;
    if (status === NO_SALES && now - checkedAt * 1000 < NO_SALES_RECHECK) {
      continue;
    }
    queue.push({ name, group: 2, checkedAt });
  }

  queue.sort((a, b) => a.group - b.group || a.checkedAt - b.checkedAt);
  return queue.map((item) => item.name);
}

function fetchPriceHistory(name) {
  const url = `${MARKET_BASE_URL}/pricehistory/?appid=570&market_hash_name=${encodeURIComponent(name)}`;

  return new Promise((resolve) => {
    community.request.get(url, (err, res) => {
      if (err) {
        resolve({ error: err.message });
        return;
      }
      if (res.statusCode == 429) {
        resolve({ rateLimited: true });
        return;
      }

      let body = null;
      try {
        body = JSON.parse(res.body);
      } catch {}

      // Without a valid session Steam answers 400 with []
      if (!body || body.success !== true) {
        resolve({ error: `HTTP ${res.statusCode}` });
        return;
      }

      resolve({
        prices: (body.prices || []).map(([time, value, volume]) => ({
          time: Date.parse(time),
          value,
          volume: parseInt(volume),
        })),
      });
    });
  });
}

async function processItems(queue, state, prices) {
  let errorsInRow = 0;
  let rateLimitHits = 0;

  for (let i = 0; i < queue.length; i++) {
    if (Date.now() - START_TIME >= MAX_DURATION) {
      console.log("Max duration reached, stopping.");
      return true;
    }

    const name = queue[i];
    const result = await fetchPriceHistory(name);
    const now = Math.floor(Date.now() / 1000);

    if (result.rateLimited) {
      if (rateLimitHits >= RATE_LIMIT_WAITS.length) {
        console.error("Still rate limited by Steam, stopping.");
        return false;
      }
      const wait = RATE_LIMIT_WAITS[rateLimitHits++];
      console.log(`Rate limited by Steam, waiting ${wait / 60000} min...`);
      await delay(wait);
      i--;
      continue;
    }
    rateLimitHits = 0;

    if (result.error) {
      const status = state[name]?.[1];
      const errors = (status < 0 ? -status : 0) + 1;
      state[name] = [now, errors >= MAX_ITEM_ERRORS ? NO_SALES : -errors];
      console.log(`[${i + 1}/${queue.length}] ${name}: ${result.error}`);

      if (++errorsInRow >= MAX_ERRORS_IN_ROW) {
        console.error(`${errorsInRow} errors in a row, stopping.`);
        return false;
      }
    } else {
      errorsInRow = 0;
      const { prices: history } = result;

      if (history.length > 0) {
        prices[name] = { steam: getWeightedAveragePrice(history) };
        fs.writeFileSync(historyPath(name), JSON.stringify(history));
        state[name] = [now, SALES];
      } else {
        state[name] = [now, NO_SALES];
      }
      console.log(`[${i + 1}/${queue.length}] ${name}: ${history.length > 0 ? "ok" : "no sales"}`);
    }

    if ((i + 1) % SAVE_EVERY == 0) {
      saveState(state);
      savePrices(prices);
    }

    await delay(REQUEST_DELAY);
  }

  return true;
}

function getWeightedAveragePrice(data) {
  const now = Date.now();

  const calculateWAP = (days) => {
    const limit = now - days * 24 * 60 * 60 * 1000;
    let totalVolume = 0;
    let totalPriceVolumeProduct = 0;

    for (const { time, value, volume } of data) {
      if (time >= limit) {
        totalPriceVolumeProduct += value * volume;
        totalVolume += volume;
      }
    }

    return totalVolume > 0 ? totalPriceVolumeProduct / totalVolume : null;
  };

  return {
    last_24h: calculateWAP(1),
    last_7d: calculateWAP(7),
    last_30d: calculateWAP(30),
    last_90d: calculateWAP(90),
    last_ever: data[data.length - 1].value,
  };
}

function loadJSON(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

function loadState() {
  const state = loadJSON(STATE_FILE, {});
  // The old format only kept a position in the list
  return "lastIndex" in state ? {} : state;
}

// One item per line so that git diffs stay small
function saveState(state) {
  const lines = Object.keys(state)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${JSON.stringify(state[name])}`);
  fs.writeFileSync(STATE_FILE, `{\n${lines.join(",\n")}\n}\n`);
}

function savePrices(prices) {
  const ordered = {};
  for (const name of Object.keys(prices).sort()) {
    ordered[name] = prices[name];
  }
  fs.writeFileSync(PRICES_FILE, JSON.stringify(ordered, null, 4));
}
