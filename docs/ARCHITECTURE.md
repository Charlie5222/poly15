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
                         gateway.polymarket.us  (public, no key)
        /v1/events   /v1/markets/{slug}/book   /v1/asset-prices/history (BRTI)   /v1/price-history
                                        │
                                  us.js │  fetchEvent, fetchBook, fetchBrti, fetchPriceHistory
                                        ▼
 ┌───────────────────────────────────────────────────────────────────────────────────────┐
 │ server.js                                                                             │
 │                                                                                       │
 │  loop() every POLL_MS (10 s):                                                         │
 │    refreshBrti ──► last 15 minutes of 1-second BRTI, in memory                        │
 │    for each horizon:                                                                  │
 │      pollHorizon ──► fetch event + order book ──► snapshot (with depth) ──► store     │
 │           ├─ at each entry time (120, 60, 30 s): paper.makePredictions + fills ──►    │
 │           │                                       predictions.jsonl                   │
 │           └─ resting maker orders: filled if a later ask trades through the bid      │
 │      settle ──► official outcome ──► rounds.jsonl ──► score ──► scored.jsonl          │
 │                                                   └─► model.add (once per entry)     │
 │    catchUp (every ~8 s, cheap): any unscored prediction up to 29 days old           │
 │    runHistory (hourly): history.backfill ──► data/history ──► backtest.json            │
 │                                                                                       │
 │  HTTP on 127.0.0.1:18790:  /  /api/now  /api/results  /api/model  /api/settings       │
 │                            /api/chart  /api/log                                       │
 └───────────────────────────────────────────────────────────────────────────────────────┘
          ▲                                       │
          │ polls the open tab only               │ store.js: every .jsonl file read once at
       ui.html                                    │ startup, then held in memory and appended to
```

**`us.js`** knows Polymarket US: slugs, fetching (with backoff on 429, no retry on 404), parsing an event into one flat object, the order book, BRTI candles, and price history. `resolvedUp` is `1`, `0`, or `null`, taken from the official settlement price, or from `outcomePrices` only once the status is `RESOLVED` or `SETTLED`. It has no state.

**`paper.js`** knows trading: BRTI spot context, features, the model, the sequential test, calibration, strategies, order-book fills, maker orders, scoring and summaries. It has no network access and no files except `model.json`.

**`store.js`** owns the data files. Each is read once at startup; afterwards everything is answered from memory and new lines are appended. This replaced v1's re-parsing of whole files every few seconds.

**`history.js`** rebuilds past rounds (backfill) and replays them walk-forward (backtest). See `docs/MODEL.md`.

**`server.js`** ties them together: the clock, settings, the HTTP API, security checks.

**`ui.html`** is the entire front end in one file. Three tabs (Now, Results, Model) and a settings sheet behind the gear. Plain DOM and canvas, no framework, no build step, follows macOS light and dark mode. The countdown ticks locally.

## The life of one round

Take the 15-minute round starting at 03:45 UTC.

1. **03:45 onward.** Every ~10 s the server fetches the event and its order book and appends a snapshot with BRTI spot, volatility, quotes and the top of the book.
2. **03:58:00, 03:59:00, 03:59:30** (120, 60, 30 s before close). On the first poll inside each window, every strategy picks a side. Taker bets are filled against the book fetched at that moment. At 60 s, maker orders are also placed at the bid. All are written to `predictions.jsonl`. **The outcome does not exist yet**; `test/safety.test.js` proves no outcome field can influence a bet.
3. **Until close.** Each later snapshot is checked against resting maker orders; one counts as filled if that side's ask drops below the bid.
4. **04:00.** The round closes and Polymarket settles on the average of the last minute of BRTI.
5. **Shortly after.** Once the official settlement appears, the round goes to `rounds.jsonl`, every bet is scored into `scored.jsonl`, and the model adds one row per entry time and refits. Gate 1 records the 60 s prediction's loss, made before the outcome was known.

If the laptop sleeps or the app is closed, `catchUp` finds every prediction without a score on the next start and fetches each round directly, up to 29 days back.

## Data files

Append-only JSON Lines, except the `.json` files. Location: `$POLY15_DATA`, which the macOS app sets to `~/Library/Application Support/Poly15/data`. Default with `npm start` is `./data`.

| file | one line per | notes |
|---|---|---|
| `snapshots.jsonl` | poll of one horizon | now includes `depth` (top 3 book levels each side, with size), `spotAt` (timestamp of the BRTI reading) and `quoteSrc` (`book` or `event`) |
| `rounds.jsonl` | settled round | the official outcome |
| `predictions.jsonl` | round and entry time bet on | features, market and model probability, every bet with its fill |
| `scored.jsonl` | settled bet | `won`, `pnl` in dollars, `entry`, `modelVersion` (2 for new data) |
| `maker-fills.jsonl` | maker order that filled | which order, and when |
| `outcomes-checked.jsonl` | round whose recorded outcome was re-checked against the official settlement | corrections are applied when loaded |
| `history/rounds-{15,5}m.jsonl` | backfilled past round | Yes/No asks per minute, compressed 1-second BRTI, official outcome |
| `backtest.json` | (whole file) latest walk-forward backtest | |
| `model.json` | (whole file) v2 model: standardization, weights, training rows, out-of-sample losses | a v1 file is ignored |
| `settings.json` | (whole file) settings | |

## HTTP API

All on `127.0.0.1:18790` (`PORT` overrides).

| method and path | returns |
|---|---|
| `GET /` | `ui.html` |
| `GET /api/now` | recording state, each live round, bets riding, recent results, backfill progress |
| `GET /api/results?entry=all\|120\|60\|30&horizon=all\|15\|5&era=new\|all` | per-strategy results with verdicts, totals, the backtest |
| `GET /api/model` | weights, gate 1, calibration, the three gates, training-row counts |
| `GET /api/chart` | BRTI one-minute candles and the current round's boundaries |
| `GET /api/log` | the last 60 log lines |
| `GET /api/settings` | current settings |
| `POST /api/settings` | any of `recording`, `stake` (above 0, up to 10,000), `stopAfter` (counted from when it was set), `entries` (subset of 120, 60, 30; 60 is always kept), `horizons` |

**Security.** Every request must carry a `Host` of `127.0.0.1:PORT` or `localhost:PORT`, which defeats DNS rebinding. A `POST` must also have no foreign `Origin`, `Content-Type: application/json`, and the header `x-poly15: 1`. A website cannot send that header cross-site without a CORS preflight, which the server never approves. The form-post attack described in v1's review now gets `403 forbidden`.

## Configuration

| environment variable | default | meaning |
|---|---|---|
| `PORT` | `18790` | HTTP port |
| `POLY15_DATA` | `./data` | where the data files go |
| `POLL_MS` | `10000` | milliseconds between polling loops |
| `POLY15_MIN_TRAINED` | `200` | training rows before the model may bet, and the gate-1 burn-in |
| `POLY15_EDGE_MARGIN` | `0.02` | how far past breakeven the model's belief must be |
| `POLY15_MIN_SPREAD` | `0.02` | how much the model's disagreement must vary to count as informative |
| `POLY15_NO_BACKFILL` | unset | `1` disables the history backfill |
| `POLY15_BACKFILL_RPS` | `4` | backfill request rate |

## External calls and their budgets

| endpoint | how often | |
|---|---|---|
| `/v1/events?slug=…` | about 2 per loop, plus settlement and catch-up lookups | published limit 25/s per IP |
| `/v1/markets/{slug}/book` | about 2 per loop | |
| `/v1/asset-prices/history` (1 s) | once per loop, only new seconds | |
| `/v1/asset-prices/history` (1 min) | at most every 45 s, for the chart | |
| backfill (`price-history`, BRTI, events) | hourly, at most 4/s | the gateway starts refusing well below 25/s |

No Coinbase calls remain.

## The macOS app

`scripts/make-app.command` writes a minimal `.app` bundle by hand: an `Info.plist`, and a bash launcher in `Contents/MacOS/Poly15` that finds Node (Homebrew, nvm, Volta, or a login shell), starts `server.js` from `Contents/Resources/app`, waits for it to answer, and opens it in a chromeless Chrome, Edge or Brave window if one is installed. Quitting the app stops the server. Logs go to `~/Library/Logs/Poly15.log`. No Xcode or signing is involved; the build clears the quarantine attribute so Gatekeeper does not block it.
