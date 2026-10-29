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

- **Recording**: works. Both horizons, about 384 rounds a day.
- **Paper trading**: works. Seven strategies bet every round, and an eighth (the model's edge bet) only once the model has earned it. P&L is in dollars at a flat $10 stake.
- **The learning model**: works, but slowly. See the finding below.
- **Real money**: deliberately not built. The Live tab is locked behind three gates.

**The most important finding so far, from simulation:** the "does the model beat the market" gate needs about **6,000 rounds** to reliably confirm even a very large planted edge (15 probability points), and it never confirms one at 2,000 rounds. A one-line change to feature scaling raises detection at 2,000 rounds from 0% to 80% with no increase in false alarms. Smaller, more realistic edges (8 points or less) are not detected within weeks either way. Details and the reproducible experiment are in [`docs/MODEL.md`](docs/MODEL.md#how-much-data-the-gate-needs).

## Run it

Needs **Node 18 or newer** and nothing else. There are no dependencies.

```bash
git clone <this repo> poly15 && cd poly15
npm test          # offline test suite, about 1 second
npm start         # serves the app on http://127.0.0.1:18790
```

Then open http://127.0.0.1:18790.

On a Mac you can also double-click `scripts/make-app.command` to build `Poly15.app`, a double-clickable app that runs the server and opens a chromeless window. Recordings then go to `~/Library/Application Support/Poly15/data`, outside the app bundle, so rebuilding never erases them.

The server binds to `127.0.0.1` only.

## What it does, briefly

```
every ~10 seconds, for each horizon (15 min, 5 min):
  1. work out the live round's slug from the clock   (btc-updown-15m-2026-10-28-0345z)
  2. fetch it from gateway.polymarket.us              (open price, quotes, fee, status)
  3. fetch BTC spot from Coinbase                     (free, keyless)
  4. append a snapshot to snapshots.jsonl

  about 60 seconds before the round closes:
  5. every strategy places a paper bet at the price actually on offer
     (written to predictions.jsonl before the outcome exists)

  after a round settles:
  6. score every bet against the real outcome         (scored.jsonl)
  7. the model learns from the round, once            (model.json)
```

The model does not predict from scratch. It predicts a **correction to the market's own price**. If it learns nothing, it reproduces the market exactly, sees nothing to disagree with, and places no bets. Its failure mode is silence, not confident nonsense.

## The app

| tab | shows |
|---|---|
| Dashboard | both live rounds with countdowns, bets riding right now, BTC 1-minute candles with the round's opening price marked |
| Paper | balance, overall win rate against the rate needed, per-strategy table with verdicts, open and recent bets |
| Model | gate 1 (model vs market), the three gates, calibration, learned weights |
| Live | locked, with the checklist that would unlock it |
| Settings | start/stop, stop betting after N rounds, stake, entry timing, horizons |

## Repository map

| path | purpose |
|---|---|
| `server.js` | recorder loop, paper betting, settlement, HTTP API, serves the UI |
| `us.js` | Polymarket US adapter: slugs, fetching, parsing, fee formula |
| `paper.js` | features, the learning model, strategies, scoring, calibration, gate 1 |
| `ui.html` | the whole front end: one file, no build step, canvas candlestick chart |
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
- [`docs/MODEL.md`](docs/MODEL.md): features, the model's math, the three gates, strategies, scoring, and the power analysis.
- [`docs/HISTORY.md`](docs/HISTORY.md): how it got here, every decision and why, including the wrong turns.

## What this is not

It is not a trading bot that makes money. Nothing here has shown an edge. The most likely outcome is that no strategy beats the fee, and the tool exists to find that out cheaply.
