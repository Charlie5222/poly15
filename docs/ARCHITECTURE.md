# Architecture

## How a Polymarket US BTC round works

Everything below rests on these facts. Each is marked with how we know it.

| fact | source |
|---|---|
| Rounds run back to back on fixed boundaries: 15-minute rounds at :00, :15, :30, :45 UTC, 5-minute rounds every 5 minutes. | slugs observed |
| Each round has a predictable slug: `btc-updown-15m-YYYY-MM-DD-HHMMz` or `btc-updown-5m-...`, where `HHMM` is the round's **start** in UTC. | two real URLs from the Polymarket app, then verified by fetching |
| The round settles **Up** if the closing price is **greater than or equal to** the opening price. Otherwise Down. | the market's own description text |
| Both the opening and closing price are the **average of 60 BRTI readings taken in the last minute** before that moment, rounded to the cent. BRTI is CF Benchmarks' Bitcoin Real-Time Index. | the market's own description text |
| The outcomes are labelled `"Yes"` and `"No"`. **"Yes" means Up.** | verified on 80 of 80 settled rounds by `tools/verify-yes-is-up.js`, 2026-10-28 |
| A round's closing price is the next round's opening price. | seen in the verification data |
| The taker fee per share is `feeCoefficient x p x (1 - p)`, with `feeCoefficient = 0.0695` read live from each market. Makers pay nothing. | coefficient read from the API; the formula's shape comes from third-party write-ups, see REVIEW.md |

## Components

```
                   gateway.polymarket.us              api.coinbase.com / api.exchange.coinbase.com
                    (public, no key)                    (public, no key)
                           │                                     │
                    us.js  │  fetchRound(date, mins)              │  spot price, 1-minute candles
                           ▼                                     ▼
 ┌───────────────────────────────────────────────────────────────────────────────────────┐
 │ server.js                                                                             │
 │                                                                                       │
 │  loop() every POLL_MS (10 s):                                                         │
 │    for each horizon:                                                                  │
 │      pollHorizon ──► snapshot ──► snapshots.jsonl                                     │
 │           │                                                                           │
 │           └─ if 5 s < time left ≤ entrySecs and not yet bet:                         │
 │                paper.makePredictions ──► predictions.jsonl                            │
 │      harvest ──► looks back 4 rounds for settled results ──► rounds.jsonl             │
 │           └─ settleRound ──► paper.score ──► scored.jsonl                             │
 │                          └─► model.train ──► model.json                               │
 │                                                                                       │
 │  HTTP on 127.0.0.1:18790:  /  /api/dashboard  /api/paper  /api/learn                  │
 │                            /api/settings (GET, POST)  /api/candles                    │
 └───────────────────────────────────────────────────────────────────────────────────────┘
                           ▲
                           │  polls every 3 s, chart every 30 s, countdown ticks locally
                        ui.html
```

**`us.js`** knows Polymarket US. It builds slugs from a date, fetches `/v1/events?slug=…`, and flattens the response into one object (`shape()`): open price, window, settlement, quotes, fee coefficient, status, and `resolvedUp`, which is `1`, `0`, or `null` while unsettled. It has no state.

**`paper.js`** knows trading. It turns a snapshot into features, holds the learning model, defines the strategies, decides each bet, scores bets, summarizes results, computes calibration, and runs gate 1. It has no network access.

**`server.js`** ties them together. It owns the clock, the files, the settings, and the HTTP API. It is one process with one event loop.

**`ui.html`** is the entire front end in one file. Plain DOM and canvas, no framework, no build step. The countdown is computed locally from each round's known end time, so it ticks every 250 ms without asking the server.

## The life of one round

Take the 15-minute round starting at 03:45 UTC.

1. **03:45 onward.** Every ~10 s the server computes the slug `btc-updown-15m-2026-10-28-0345z`, fetches it, fetches BTC spot, and appends a snapshot.
2. **~03:59:00** (60 s before close, configurable). On the first poll inside the window, `paper.makePredictions` builds the features and every strategy picks a side at the price on offer. The bets are written to `predictions.jsonl`. **The outcome does not exist yet**, and a test (`test/safety.test.js`) proves no outcome field can influence a bet.
3. **04:00.** The round closes. Polymarket averages the last minute of BRTI readings and settles.
4. **Shortly after.** On each loop, `harvest` re-fetches the last four rounds of each horizon. Once this round shows a settlement, it is appended to `rounds.jsonl` and `settleRound` scores every bet into `scored.jsonl`, then trains the model **once** on that round.

Because bets are written before settlement and training happens after, the model is always evaluated **walk-forward**: it is scored only on rounds it had not seen.

## Data files

All are append-only JSON Lines (one JSON object per line), except the two `.json` files. Location: `$POLY15_DATA`, which the macOS app sets to `~/Library/Application Support/Poly15/data`. Default when run with `npm start` is `./data`.

| file | one line per | written by |
|---|---|---|
| `snapshots.jsonl` | poll of one horizon (about 17,000 a day, ~650 bytes each) | `pollHorizon` |
| `rounds.jsonl` | settled round, with its outcome | `harvest` |
| `predictions.jsonl` | round bet on: features, market and model probability, and every strategy's bet | `pollHorizon` |
| `scored.jsonl` | individual settled bet, with `won` and `pnl` in dollars | `settleRound` |
| `model.json` | (whole file) weights, bias, rounds trained, the last 3,000 per-round losses | `model.save` |
| `settings.json` | (whole file) the Settings tab | `POST /api/settings` |

A **snapshot** contains, among others:

```json
{ "ts": "2026-10-28T03:58:58.120Z", "secsToClose": 62, "spot": 81090.12, "momentum": 0.31, "vol": 7.42,
  "horizon": 15, "slug": "btc-updown-15m-2026-10-28-0345z", "status": "MARKET_STATUS_OPEN",
  "priceToBeat": 81079.52, "settlementPrice": null, "resolvedUp": null, "indexSymbol": "BRTI",
  "windowStart": "2026-10-28T03:45:00Z", "windowEnd": "2026-10-28T04:00:00Z",
  "yesPrice": 0.22, "yesQuote": 0.23, "noPrice": 0.23, "noQuote": 0.78, "feeCoefficient": 0.0695 }
```

How the quote fields are read (inferred from live observation, see REVIEW.md): `yesQuote` is what it costs to buy Yes (Up) and `noQuote` is what it costs to buy No (Down). The market's own probability of Up is the midpoint `(yesQuote + (1 - noQuote)) / 2`.

## HTTP API

All on `127.0.0.1:18790` (`PORT` overrides).

| method and path | returns |
|---|---|
| `GET /` | `ui.html` |
| `GET /api/dashboard` | recording state, each live round, open bets, counts |
| `GET /api/paper` | balance, overall and per-strategy results, open and recent bets |
| `GET /api/learn` | weights, gate 1 benchmark, calibration, the three gates |
| `GET /api/candles` | last 120 one-minute BTC candles, current round boundaries, spot |
| `GET /api/settings` | current settings |
| `POST /api/settings` | accepts any of `recording`, `stake` (above 0, up to 10,000), `stopAfter`, `entrySecs` (10 to 600), `horizons` (`[15]`, `[5]`, or `[15, 5]`). Invalid values are ignored. |

There is no authentication. See REVIEW.md: this endpoint can be triggered by any website the user visits.

## Configuration

| environment variable | default | meaning |
|---|---|---|
| `PORT` | `18790` | HTTP port |
| `POLY15_DATA` | `./data` | where the data files go |
| `POLL_MS` | `10000` | milliseconds between polling loops |
| `POLY15_MIN_TRAINED` | `200` | settled rounds before the model may place edge bets |
| `POLY15_EDGE_MARGIN` | `0.02` | how far past breakeven the model's belief must be |
| `POLY15_MIN_SPREAD` | `0.02` | how much the model's disagreement with the market must vary to count as informative |

## External calls and their budgets

| endpoint | how often | limit |
|---|---|---|
| `gateway.polymarket.us/v1/events?slug=…` | about 2 per loop plus up to 8 harvest lookups | 25 requests per second per IP, published |
| `api.coinbase.com/v2/prices/BTC-USD/spot` | at most every 5 s | public |
| `api.exchange.coinbase.com/.../candles?granularity=60` | at most every 45 s | public |

The countdown deliberately does not poll. Polling the market every second would be about 170,000 requests a day for a number computable from the round's end time.

## The macOS app

`scripts/make-app.command` writes a minimal `.app` bundle by hand: an `Info.plist`, and a bash launcher in `Contents/MacOS/Poly15` that finds Node (Homebrew, nvm, Volta, or a login shell), starts `server.js` from `Contents/Resources/app`, waits for it to answer, and opens it in a chromeless Chrome, Edge or Brave window if one is installed. Quitting the app stops the server. Logs go to `~/Library/Logs/Poly15.log`. No Xcode or signing is involved; the build clears the quarantine attribute so Gatekeeper does not block it.
