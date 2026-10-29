# Review guide

For anyone, human or AI, reviewing poly15. It separates what has been **verified** from what is **assumed**, lists **known issues** ranked by severity with file and line, and ends with **open questions** where an outside opinion would help most.

## What to review, in one paragraph

poly15 records Polymarket US's 5- and 15-minute BTC up/down rounds, paper-trades seven fixed strategies and one learning model on every round, and judges them against the fee. The parts that matter most are **whether the results it reports can be trusted**: no look-ahead, correct outcome labels, correct fee and P&L accounting, honest significance, and whether the model's go/no-go gate can actually detect an edge. Code quality matters less than those.

## How to check things yourself

```bash
npm test                                   # offline, deterministic, about 1 second
node tools/experiments/power.js --rounds 2000 --edge 0.15 --seeds 40
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
| A planted edge is detected, given enough rounds. | `test/model.test.js` at 6,000 rounds; see the power table in `docs/MODEL.md` |
| A loss costs exactly the stake. | `test/safety.test.js` across prices from 5¢ to 95¢ |
| `scripts/make-app.command` builds an app that boots. | built from a clean copy and queried |

## Assumed, not verified

Ranked by how much would break if wrong.

1. **Quote semantics.** `yesQuote` is treated as the cost to buy Yes and `noQuote` as the cost to buy No (`us.js:103`, `us.js:105`, `paper.js:231`). Inferred from live observation, for example Yes `price` 0.10 / `quote` 0.11 alongside No `price` 0.11 / `quote` 0.90, which only makes sense as asks. Not documented anywhere we found. If wrong, every entry price and therefore every P&L figure is wrong.
2. **Fills.** Every bet is assumed filled in full at that quote. There is no depth, no slippage, and no check that $10 of size exists at the top of the book.
3. **Fee formula shape.** `coefficient x p x (1 - p)` (`paper.js:234`). The coefficient is live; the shape comes from third-party write-ups of Polymarket US's fee schedule, not from official documentation. The international venue uses a different exponent.
4. **Settlement fields.** `assetPriceTerms.settlementPrice` is assumed to appear once a round settles, with `outcomePrices` as a fallback (`us.js:77`). The 80-round check above found the two always agree.
5. **Slug stability.** If Polymarket changes the slug scheme, discovery silently finds nothing ("round not listed yet").

---

## Known issues

### High

**H1. The model learns a real edge too slowly for gate 1 to confirm it in practical time.**
`paper.js:82` divides the volatility-scaled move by 4, so that input averages about 0.09. The weight needed to express a 15-point edge is about 6.7. After 10,000 rounds it reaches about 2.5, while the learning rate (`0.10 / (1 + n / 1200)`) has decayed to a tenth. Measured with `tools/experiments/power.js`: a 15-point planted edge is detected 0 out of 60 times at 2,000 rounds, 95% at 4,000, and 100% at 6,000, with zero false alarms throughout. Removing the `/ 4` raises detection at 2,000 rounds to 80%, still with zero false alarms. Edges of 8 points or fewer are not detected at any tested size, with or without the change.
*Consequence:* the stopping rule agreed during development ("give up if gate 1 hasn't passed by 2,000 rounds") would abandon even a huge edge, and has been retracted.
*Candidate fixes:* remove the `/ 4` and reset `model.json`; or replace the decaying-rate online update with a full refit (for example Newton's method on all settled rounds) after each round, which is cheap at this data size and would remove the learning-speed problem entirely; or standardize features online.

**H2. The dashboard re-reads and parses entire log files every 3 seconds.**
`server.js:232` parses all of `snapshots.jsonl` just to count its lines. `openBets()` (`server.js:194`) parses all of `predictions.jsonl`, and the UI requests `/api/paper` every 3 seconds even off the Paper tab (`ui.html:671`), which parses all of `scored.jsonl`. Snapshots grow about 11 MB a day. After 7 days, one parse of `snapshots.jsonl` (about 79 MB) took about 530 ms on the machine used for testing. These are synchronous reads on the single thread that also polls the market, so as the files grow the poller is delayed and will eventually miss its betting window.
*Fix:* keep running counts and recent rows in memory; read files only at startup.

**H3. Any website the owner visits can change the app's settings.**
`POST /api/settings` (`server.js:319`) has no authentication and parses any request body as JSON regardless of `Content-Type` (`server.js:324`). A `<form enctype="text/plain" method="post">` on any site can send a body like `{"recording":false,"stake":9999,"x":"="}` without a CORS preflight. **Confirmed:** that request flipped recording off and set the stake to 9,999. Impact today is limited to paper settings. It must be fixed before any real-money feature exists.
*Fix:* reject anything that is not `Content-Type: application/json` (which forces a preflight the server already fails), check the `Origin` header, and/or require a per-launch token.

### Medium

**M1. After downtime, settled rounds are missed and some bets stay "riding" forever.**
`harvest` only looks back 4 rounds per horizon (`server.js:163`): one hour of 15-minute rounds, 20 minutes of 5-minute ones. If the app is closed or the laptop sleeps for longer, rounds that settle in that gap are never recorded, bets placed just before shutdown are never scored, they appear under "Bets riding now" indefinitely, and the model never trains on them.
*Fix:* on startup, scan `predictions.jsonl` for unscored slugs and fetch each directly.

**M2. The volatility input assumes a fixed 15-second spacing that does not exist.**
`paper.js:71` converts elapsed time to sample count as `elapsed / 15`. Spot is actually sampled from a 5-second cache once or twice per 10-second loop depending on network latency (`server.js:53` to `server.js:74`), so the interval between samples varies from about 1 to 10 seconds. `vol`, the standard deviation of consecutive changes, therefore depends on timing jitter, and the scaling in `moveZ` is off by a varying factor.
*Fix:* record each sample's timestamp and compute volatility per square-root second.

**M3. The signal is measured on a different price than the one that settles.**
Spot comes from Coinbase (`server.js:65`). Settlement uses BRTI, averaged over the final minute. Both `moveZ` and `momentum` therefore carry a basis and a timing mismatch. Not fatal for learning, which can absorb a consistent offset, but the "move since open" shown in the UI is approximate.

**M4. Fills are optimistic.** See assumption 2. Any edge found should be discounted for depth and slippage before it is believed.

### Low

**L1. Gates 2 and 3 are never computed.** Both are hard-coded as not passed (`server.js:287`, `server.js:289`). The calibration table is shown for a person to judge.

**L2. "Stop betting after N" counts every round ever settled.** `server.js:96` compares against the all-time total, so setting it below the existing count stops betting immediately.

**L3. The informativeness check counts each round twice.** `Model.prob` appends to the window it measures (`paper.js:146`), and `train` calls `prob` again (`paper.js:166`).

**L4. One machine.** Recording stops whenever the laptop sleeps or the app is closed.

### Fixed while preparing this repo

- `scripts/make-app.command` never copied `paper.js`, so a fresh build crashed on launch.
- The helper scripts health-checked `/api/state`, which no longer exists; `curl -s` treated the 404 as success.
- Two test files targeted the old model interface and no longer ran; their key checks are now `test/safety.test.js`.
- `test/model.test.js` failed about 1 run in 20; it is now seeded and sized for reliable detection.

---

## Deliberately not done

- **No real orders**, no keys, no wallet. The Live tab is a locked checklist.
- **No neural networks or tree ensembles.** With a few thousand near-coin-flip outcomes, flexible models find convincing patterns in noise. If a simple model anchored to the market cannot find an edge, a complex one has not found one either; it is just better at hiding that.
- **No dependencies.** Plain Node 18+ and one HTML file.
- **No per-second polling** of the market. The countdown is computed locally.

## Open questions where a review would help most

1. **Is the gate-1 test right?** It compares mean per-round log loss of the model against the market's midpoint, at three standard errors, over up to 3,000 rounds. Would a paired bootstrap, a Brier score, or a sequential test (one designed for repeated looks at accumulating data) be more appropriate?
2. **Online SGD or periodic full refit?** See H1. A full refit removes the learning-rate problem, but changes how "walk-forward" is enforced. What is the cleanest way to keep evaluation strictly out-of-sample?
3. **Multiple comparisons.** Eight strategies, two horizons, and a user who will look at the screen many times a day. Is three standard errors enough, or should verdicts use a sequential or corrected threshold?
4. **The entry moment.** Bets go in 60 seconds before close, which is exactly when the settlement's 60-reading averaging window opens. Does that timing create any structural bias, or a structural opportunity, in how the closing price relates to the price seen at entry?
5. **Is the midpoint the right market baseline?** The model is anchored to `(yesAsk + yesBid) / 2`. Should gate 1 instead compare against the price actually payable?
6. **Does any edge here survive realistic fills?** Given H1's finding that only very large edges are detectable in weeks, is this experiment worth continuing as designed, or should it pivot (for example to making markets rather than taking them, since makers pay no fee)?
