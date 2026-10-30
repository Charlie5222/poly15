# Review guide

For anyone, human or AI, reviewing poly15. It separates what has been **verified** from what is **assumed**, lists **known issues** ranked by severity with file and line, and ends with **open questions** where an outside opinion would help most.

## What to review, in one paragraph

poly15 records Polymarket US's 5- and 15-minute BTC up/down rounds, paper-trades fixed, maker and model strategies at three entry times every round, backtests on about four weeks of history, and judges them against the fee. The parts that matter most are **whether the results it reports can be trusted**: no look-ahead, correct outcome labels, correct fee and P&L accounting, honest significance, and whether the model's go/no-go gate can actually detect an edge. Code quality matters less than those.

## How to check things yourself

```bash
npm test                                   # offline, deterministic, about 1 second
node tools/experiments/power.js --rounds 2000 --edge 0.15 --seeds 20 --refit 1
SEED=7 node test/model.test.js             # the model suite under a different random draw
node tools/verify-yes-is-up.js             # needs network access to gateway.polymarket.us
```

`npm start` runs the app on `http://127.0.0.1:18790`. Polymarket US's gateway may not be reachable from every network or sandbox; the tests do not need it.

---

## Verified

| claim | evidence |
|---|---|
| The market's "Yes" pays out exactly when BTC finished up. | 80 of 80 settled rounds, both horizons, `tools/verify-yes-is-up.js`, 2026-10-28 |
| Up wins on a tie (`>=`). | the market's own description text; `us.js:78` uses `>=` |
| Open and close prices are each a 60-reading average of BRTI over the final minute. | the market's own description text |
| Slugs follow `btc-updown-{15m,5m}-YYYY-MM-DD-HHMMz` keyed on the round's start. | two real URLs, fetched successfully for both horizons, and `test/us.test.js` against a captured payload |
| `feeCoefficient` is 0.0695 on these markets. | read live from every market |
| A prediction cannot depend on the round's outcome. | `test/safety.test.js`: identical bets with and without outcome fields attached |
| An untrained model reproduces the market exactly and places no edge bets. | `test/model.test.js` (to 9 decimal places) and `test/safety.test.js` |
| On a fair market, nothing is reported as profitable and gate 1 never passes. | `test/model.test.js`, and 0 false alarms in every power-analysis run |
| A planted edge is detected, given enough rounds. | `test/model.test.js`; see the power table in `docs/MODEL.md` |
| The sequential test stays valid under constant peeking. | `test/model.test.js`: checked after every round on a fair market |
| A cross-site form post cannot change settings. | sent the original attack against the new server: 403 |
| A loss costs exactly the stake. | `test/safety.test.js` across prices from 5¢ to 95¢ |
| `scripts/make-app.command` builds an app that boots. | built from a clean copy and queried |

## Assumed, not verified

Ranked by how much would break if wrong.

1. **Quote semantics.** `yesQuote` is treated as the cost to buy Yes and `noQuote` as the cost to buy No (`us.js:103`, `us.js:105`, `paper.js:231`). Inferred from live observation, for example Yes `price` 0.10 / `quote` 0.11 alongside No `price` 0.11 / `quote` 0.90, which only makes sense as asks. Not documented anywhere we found. If wrong, every entry price and therefore every P&L figure is wrong.
2. **Fills.** Taker bets now walk the real book, which is accurate unless the book changes between the fetch and the moment an order would arrive. Maker fills are inferred (see O2).
3. **Fee formula shape.** `coefficient x p x (1 - p)` (`paper.js:234`). The coefficient is live; the shape comes from third-party write-ups of Polymarket US's fee schedule, not from official documentation. The international venue uses a different exponent.
4. **Settlement fields.** `assetPriceTerms.settlementPrice` is used once a round settles, with `outcomePrices` as a fallback only when the status says resolved. Before that fix, 73 of 366 v1 outcomes were wrong.
5. **Slug stability.** If Polymarket changes the slug scheme, discovery silently finds nothing ("round not listed yet").

---

## Known issues

### Fixed in the October 2026 improvements (v2)

| was | what changed |
|---|---|
| **H1.** The model learned too slowly for gate 1 to confirm even a huge edge in under ~6,000 rounds. | Full ridge-logistic refit after every round on standardized features, gate-1 burn-in, anytime-valid sequential test. A 15-point edge is now detected in most runs by 1,500 to 2,000 rounds; see `docs/MODEL.md`. |
| **H2.** Whole log files were re-parsed every few seconds. | `store.js` reads each file once at startup and serves from memory. The UI only polls the open tab. |
| **H3.** Any website could change settings with a form post. | `Host` allowlist, `Origin` check, `Content-Type: application/json` and an `x-poly15: 1` header are required. The original attack now gets 403. |
| **M1.** Rounds were missed after sleep; bets could stay "riding" forever. | `catchUp` scores every unscored prediction up to 29 days old, fetching each round directly. |
| **M2.** Volatility assumed fixed sample spacing. | Spot is BRTI at 1-second resolution with timestamps; volatility is per square-root second. |
| **M3.** Signal measured on Coinbase, settlement on BRTI. | Spot is now BRTI, from Polymarket US's own endpoint. |
| **M4.** Fills assumed unlimited size at the quote. | Taker bets walk the real order book; maker orders fill only if a later ask trades through them. |
| **L1.** Gates 2 and 3 were never computed. | Both are computed. |
| **L2.** "Stop after N" counted all-time rounds. | Counts from when it was set. |
| **L3.** The informativeness check double-counted rounds. | Computed once, at refit. |
| *(new)* Outcomes were read from `outcomePrices` while rounds were still trading. | Official settlement only, or `outcomePrices` once `RESOLVED`/`SETTLED`. Re-checking all v1 data corrected **73 of 366** rounds. |
| *(new)* v1 bets used event-level quotes that went stale or one-sided in the final minute, producing absurd paper profits (a $10 bet "at 1¢" paying about $990). | v2 uses the order book. Results show v2 data by default; v1 is behind an "Include v1" toggle with a warning. |

### Still open

**O1. Realistic edges are not detectable quickly.** Edges of 8 points or less were not detected in any run up to 2,000 rounds. That is the statistics of near-coin-flips, not a bug. Backfilled history gives the model training rows immediately, but gate 1 only counts live predictions.

**O2. Maker fills are optimistic.** "Someone traded through my bid" ignores queue position. Maker results are an upper bound.

**O3. Backtest fills are optimistic.** History has the best asks per minute but no depth, and entries can be up to 30 s stale.

**O4. One machine.** Recording stops while the laptop sleeps. `catchUp` scores what was already bet, but rounds during sleep are never bet on. An always-on server was deferred.

**O5. Fee formula shape** is still from third-party write-ups (assumption 3).

## Deliberately not done

- **No real orders**, no keys, no wallet. The Live tab is a locked checklist.
- **No neural networks or tree ensembles.** With a few thousand near-coin-flip outcomes, flexible models find convincing patterns in noise. If a simple model anchored to the market cannot find an edge, a complex one has not found one either; it is just better at hiding that.
- **No dependencies.** Plain Node 18+ and one HTML file.
- **No per-second polling** of the market. The countdown is computed locally.

## Open questions where a review would help most

Questions 1 to 3 from the first review were answered by v2: gate 1 is now a sequential (anytime-valid) test, the model is fully refit, and strategy verdicts use a sequential test with a Bonferroni-corrected level. What remains:

1. **The entry moment.** Bets go in at 120, 60 and 30 seconds before close; the settlement's 60-reading averaging window opens at 60. Does the 30 s entry, which sits inside that window and can partly see it, have a structural advantage that should be priced in rather than called an edge?
2. **Is the midpoint the right baseline for gate 1?** The model is anchored to the quote midpoint. Should gate 1 compare against the price actually payable?
3. **Is the maker fill rule reasonable?** "A later ask below my bid" is a proxy for being filled. Is there a better one from the book data now recorded?
4. **Is the backtest honest enough to act on?** It is walk-forward, but uses minute quotes without depth. What discount should be applied before believing a backtest result?
