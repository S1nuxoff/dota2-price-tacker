# Dota 2 Price Tracker

Approximate prices of Dota 2 items on trading platforms: the lowest offer for each item on [DMarket](https://dmarket.com) and [Skinport](https://skinport.com). These are the markets' own prices, not Steam Community Market prices.

## Data

`static/prices/latest.json`, one item per line, keyed by the market hash name:

```json
"Dragonclaw Hook":{"price":265.02,"dmarket":{"price":265.02,"offers":9},"skinport":{"price":289.5,"offers":2}}
```

- `price` - the lowest offer across the markets, in USD
- `dmarket`, `skinport` - the market's lowest offer and the number of offers; a market without offers for the item is left out

Only items on sale on at least one market are listed.

## How it works

`node index.js` reads both markets' public APIs, no keys or accounts needed: Skinport's `/v1/items` returns every Dota 2 item in one answer, DMarket's `aggregated-prices` about 1000 items per request. A run takes under a minute. If a market fails, its prices from the previous run are kept and the run fails.

The GitHub Actions workflow runs it every 20 minutes and commits the result. Dotadex reads `latest.json` from this repository in the browser, so new prices show on the site without a rebuild.
