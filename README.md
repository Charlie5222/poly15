# poly15

poly15 watches Polymarket US's **5-minute and 15-minute "BTC Up or Down" markets**, places **paper bets** on every round, and keeps score. It answers one question before any real money is involved: **does any strategy win often enough to beat Polymarket's taker fee?**

It never places a real order. It holds no keys and no wallet, and it reads only public market data.

> **If you are an AI or human reviewing this repo**, start with [`docs/REVIEW.md`](docs/REVIEW.md). It lists what has been verified, what is assumed, and the known issues ranked by severity.

---

## The question in one table

On Polymarket US, a taker pays `0.0695 x price x (1 - price)` per share. That fee is largest exactly where a coin flip sits:

| you buy at | fee per $1 share | fee as % of your bet | win rate needed just to break even |
|---|---|---|---|
| 50¢ | 1.74¢ | 3.48% | **51.7%** |
| 60¢ | 1.67¢ | 2.78% | 61.7% |
| 70¢ | 1.46¢ | 2.09% | 71.5% |
| 80¢ | 1.11¢ | 1.39% | 81.1% |

So a strategy that "wins more than half the time" can still lose money. poly15 always reports a strategy's win rate **next to the win rate it actually needed**, given the prices it actually paid.

## Where things stand

- **Recording**: works. Both horizons, about 384 rounds a day, with order-book depth and BRTI (the index the rounds settle on).
- **Paper trading**: works. Eleven strategies, including two maker (no-fee, resting order) strategies, bet at 120, 60 and 30 seconds before close. Taker bets fill against the real order book.
- **History**: about four weeks of past rounds are backfilled from Polymarket US's own endpoints and replayed as a walk-forward backtest. They also give the model training rows from day one.
- **The learning model (v2)**: a full ridge-logistic refit after every round. Gate 1 uses a sequential test that stays honest however often you look.
- **Real money**: deliberately not built. It stays locked behind three gates, all now computed.

**What the statistics allow:** in simulation, gate 1 now catches a very large planted edge (15 probability points) 90% of the time by 2,000 live rounds (about 5 days); v1 caught it 0% of the time at that point and needed about 6,000. It has **never** falsely passed on a fair market. Realistic edges (8 points or less) are still not detectable within weeks, and that is a property of coin-flip outcomes, not of the code. Details in [`docs/MODEL.md`](docs/MODEL.md#how-much-data-gate-1-needs).

## Run it

Needs **Node 18 or newer** and nothing else. There are no dependencies.

```bash
git clone <this repo> poly15 && cd poly15
npm test          # offline test suite, a few seconds
npm start         # serves the app on http://127.0.0.1:18790
```

Then open http://127.0.0.1:18790.

On a Mac you can also double-click `scripts/make-app.command` to build `Poly15.app`, a double-clickable app that runs the server and opens a chromeless window. Recordings then go to `~/Library/Application Support/Poly15/data`, outside the app bundle, so rebuilding never erases them.

The server binds to `127.0.0.1` only.

## What it does, briefly

```
every ~10 seconds, for each horizon (15 min, 5 min):
  1. work out the live round's slug from the clock   (btc-updown-15m-2026-10-28-0345z)
  2. fetch the event and its order book               (gateway.polymarket.us)
  3. read BTC from BRTI, 1-second resolution           (the index the round settles on)
  4. append a snapshot, with book depth

  at 120, 60 and 30 seconds before close:
  5. every strategy places a paper bet, filled against the real order book
     (written to predictions.jsonl before the outcome exists)

  after a round settles (official settlement only):
  6. score every bet                                   (scored.jsonl)
  7. the model adds the round and refits               (model.json)

  on startup and continuously: score anything missed while the Mac slept
  hourly: backfill past rounds and re-run the backtest
```

The model does not predict from scratch. It predicts a **correction to the market's own price**. If it learns nothing, it reproduces the market exactly, sees nothing to disagree with, and places no bets. Its failure mode is silence, not confident nonsense.

## The app

Three tabs, with settings behind the gear. Follows macOS light and dark mode.

| tab | shows |
|---|---|
| Now | both live rounds with countdowns and the model's view, bets riding, BTC candles with the opening price marked |
| Results | paper P&L and win rate against the rate needed, per-strategy verdicts, filters for entry time, horizon and v1 data, the backtest |
| Model | the three gates, gate 1's progress, calibration, what the model has learned |
| ⚙︎ | recording on/off, stop after N rounds, stake, entry times, horizons |

## Repository map

| path | purpose |
|---|---|
| `server.js` | recorder loop, paper betting, settlement, catch-up, HTTP API and its security checks |
| `us.js` | Polymarket US adapter: slugs, fetching, parsing, fee formula |
| `paper.js` | features, the model, the sequential test, strategies, order-book fills, scoring, calibration |
| `store.js` | the data files: read once at startup, held in memory, appended to |
| `history.js` | backfill of past rounds, walk-forward backtest |
| `ui.html` | the whole front end: one file, no build step, three tabs, canvas candlestick chart |
| `test/` | offline tests, including one against a real captured market payload |
| `scripts/` | macOS helpers: build the app, open it, restart it, dump its state |
| `tools/verify-yes-is-up.js` | checks against settled rounds that the market's "Yes" means Up |
| `tools/experiments/power.js` | reproduces the detection-power numbers |
| `tools/probes/` | the scripts used to work out the undocumented API, with what each found |
| `legacy/` | the first version, built for the international venue the owner cannot trade |
| `docs/` | architecture, model, history, and the review guide |

## Documentation

- [`docs/REVIEW.md`](docs/REVIEW.md): start here if reviewing. Verified facts, assumptions, known issues, questions worth asking.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components, data flow, file formats, the HTTP API, how Polymarket US rounds work.
- [`docs/MODEL.md`](docs/MODEL.md): features, the model's math, the three gates, history and the backtest, strategies, fills, scoring, and the power analysis.
- [`docs/HISTORY.md`](docs/HISTORY.md): how it got here, every decision and why, including the wrong turns.

## What this is not

It is not a trading bot that makes money. Nothing here has shown an edge. The most likely outcome is that no strategy beats the fee, and the tool exists to find that out cheaply.
