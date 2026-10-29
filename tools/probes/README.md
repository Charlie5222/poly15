# tools/probes/

How the Polymarket US public API was worked out. Polymarket US's market-data
gateway had no documentation we could find for these markets, so each probe
asked one question of `gateway.polymarket.us` and the next probe built on the
answer. All are read-only: public endpoints, no key, no orders. Each writes a
`probeN-us.json` beside itself (ignored by git).

They are kept as the evidence trail for the assumptions in `us.js`. You do not
need them to run the app.

| probe | question | answer |
|---|---|---|
| `probe-us.js` | Is the gateway reachable, and which list endpoint works? | Only `/v1/markets` answered 200. |
| `probe2-us.js` | Are there BTC up/down markets in that list? | None. Filters were silently ignored. |
| `probe3-us.js` | Page the whole list and count categories. | 2,599 markets, all closed sports. `/v1/markets` is an archive, not the live board. |
| `probe4-us.js` | What else exists? | `/v1/series` lists `btc`, `/v1/tags` has `bitcoin-4h`. Crypto is there. |
| `probe5-us.js` | Pull the Bitcoin series. | `/v1/events?seriesId=101` returns live crypto events with `feeCoefficient: 0.0695`, but long-dated ones. |
| `probe6-us.js` | Find the short rounds by tag. | Tags `ethereum-15m` and `15M` exist; filtering by tag does not work. |
| `probe7-us.js` | Using the slug format from a real URL, fetch a live round. | `/v1/events?slug=btc-updown-15m-YYYY-MM-DD-HHMMz` works for both horizons. |
| `probe8-us.js` | Dump one live round in full. | Found `assetPriceTerms` (open price, window, settlement, `BRTI` index) and the side quotes. |

The breakthrough was the owner pasting two real URLs from the Polymarket app,
which gave the slug format directly. A captured copy of the probe 8 payload
lives at `test/fixtures/live-round-15m.json` and the parser is tested against it.
