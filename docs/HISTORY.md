# How poly15 got here

A decision log, in order. It includes the wrong turns, because a reviewer should know which conclusions were revised and why. Built over two sessions on 2026-10-27 and 2026-10-28 by the owner, Charlie, working with Claude.

## 1. Starting point: someone else's bot

The project began with a question about [CloddsBot](https://github.com/alsk1992/CloddsBot), an open-source "AI trading agent" claiming 1,000+ markets, 118+ strategies, and up to 200x leverage, built in 12 days for a hackathon. Its README carries no live performance data.

Two things ruled it out:

- **Robinhood.** It has no Robinhood integration, and Robinhood has no public trading API. Bots that trade Robinhood reverse-engineer its private endpoints, which breaks its terms and means storing your brokerage password and 2FA seed in a file.
- **Trust.** The owner did not want a third-party repo holding his credentials. So we built from scratch, read-only, and kept it that way.

## 2. Narrowing the target

The owner settled on Polymarket's **15-minute "BTC Up or Down"** markets. The first and most durable point made: a 15-minute up/down contract is close to a coin flip, and the taker fee peaks at exactly 50¢. Polymarket introduced these fees in January 2026 specifically to stop latency-arbitrage bots on these markets. Any strategy has to beat that fee on every bet.

## 3. Version 1: the wrong venue

The first build targeted the **international** Polymarket (`gamma-api.polymarket.com` and `clob.polymarket.com`). It had a recorder and an analyzer (now in `legacy/`). The analyzer was validated on 5,000 simulated fair-coin rounds: every strategy landed near the analytically predicted −3.96% return, confirming the fee math.

The owner then asked for something that looked like an app rather than a terminal, so it gained a local server, a chat-style UI, and a hand-built macOS `.app`. Recordings were moved to `~/Library/Application Support/Poly15/data` so that rebuilding the app could not erase them.

## 4. Discovering there are two Polymarkets

Asked "how do I connect it to Polymarket?", we found the owner's account is on **Polymarket US**: a separate, CFTC-regulated exchange with its own order book, its own API, and different fees. Version 1 was recording a market he cannot trade.

## 5. Working out the Polymarket US API, including a wrong conclusion

There was no documentation we could find for these markets, so the API was probed one question at a time (`tools/probes/`, with a table of what each found).

- Probes 1 to 3 paged through `/v1/markets`: **2,599 markets, every one a closed sports game.** We concluded, with a stated caveat, that Polymarket US probably did not list BTC rounds.
- **That was wrong.** The owner opened the Polymarket app on his phone and saw 5-minute and 15-minute BTC rounds immediately. The tell had been there: zero of those 2,599 markets were open, so `/v1/markets` was an archive, not the live board.
- Probes 4 to 6 found the crypto series and tags.
- The owner pasted two real URLs, `.../btc-updown-15m-2026-10-28-0345z` and `.../btc-updown-5m-2026-10-28-0350z`, which gave the slug format directly.
- Probes 7 and 8 fetched a live round by slug and found `assetPriceTerms`, which carries the open price, the window, the settlement, and the BRTI index name.

**A second correction came out of this.** An earlier message quoted Polymarket US's taker fee as a flat 0.30%, from a third-party article. The live API reported `feeCoefficient: 0.0695`, which works out to 3.48% of a 50¢ bet and a 51.7% breakeven, slightly *worse* than the international venue.

## 6. 5 minutes or 15 minutes

15-minute rounds have more time for a real move to develop, so their prices drift away from 50¢ more often, where the fee is cheaper. 5-minute rounds give three times the data. Decision: record both, and let the data decide.

## 7. The US adapter, and the first bug a test caught

`us.js` was written against the real payload. Its first test failed: `Number(null)` is `0` in JavaScript, not an error, so an **unsettled** round's missing settlement price was being read as zero, which made every unfinished round look like it had settled **Down**. Every label in the dataset would have been wrong while looking normal. Fixed in `num()`, and tested.

## 8. Paper trading, and three more things tests caught

Strategies and an online logistic-regression model were added, with bets written before each round settles.

1. **A model with no opinion "found edge".** An untrained model outputs exactly 50%, which beats the breakeven on any side priced under 50¢. That is just always buying the underdog. Fix: no edge bets until the model has trained on 200 rounds.
2. **A trained but flat model did the same.** Fix: the model must also be *informative*, meaning its predictions vary with its inputs.
3. **A simulated test "found profit" on random data.** Not a bug in the app: the simulation's prices wandered independently of the outcome, so the simulated market was mispriced and betting the underdog genuinely won. The test was rebuilt as two worlds: an efficient market where nothing may win, and a rigged one with a planted edge that must be found. A test that only checks one direction can be passed by code that never finds anything.

Separately, the significance threshold was raised from two standard errors to three, after measuring that with eight strategies judged side by side, a two-standard-error rule labels pure coin flips profitable about 4% of the time.

## 9. Version 2: the redesign

The owner disliked the chat interface and asked for tabs, a BTC candlestick chart, controls, and a real plan for the learning. Before building, a plan was agreed:

- **Anchor the model to the market.** Predict a correction to the market's price, so a model that learns nothing stays silent.
- **Gate 1:** the model must out-predict the market's own price.
- **Gate 2:** calibration. When it says 70%, does it win 70%?
- **Gate 3:** profit after fees, only once 1 and 2 pass.
- **Scale BTC's move by recent volatility**, since a $20 move means different things in calm and wild hours.
- **A failure rule agreed in advance:** if gate 1 has not passed after 2,000 rounds, stop. *This rule was later shown to be wrong; see step 12.*

When built, gate 1 first **missed a planted edge**. Regularization was loosened, the learning-rate decay slowed, and the comparison window widened from 500 to 3,000 rounds.

## 10. Small fixes the owner asked for

- **The countdown only moved every 5 seconds.** The whole page waited on the server. The countdown now runs locally from each round's known end time, while prices refresh every 3 seconds. Polling the market every second was deliberately avoided: about 170,000 requests a day for a number that can be computed.
- **Nowhere showed bets that hadn't settled.** For the 60 seconds a bet was live, nothing on screen acknowledged it. Added "Bets riding now".
- **An overall win rate.** Added, with the rate actually needed beside it, and shown both with and without the two mirror-image baselines.

## 11. Preparing this repository

Building the repo meant re-reading every file, which surfaced several things:

- **Verified, not assumed:** the market's "Yes" pays out exactly when BTC finished up, on 80 of 80 settled rounds (`tools/verify-yes-is-up.js`). If this had been backwards, every paper result would have been inverted.
- **Found in the market's own text:** both the opening and closing price are the average of 60 BRTI readings in the last minute, not a single tick.
- **The build script never copied `paper.js`**, so a fresh build produced an app that crashed on launch. The running copy only worked because the file had been copied in by hand. Fixed in `scripts/make-app.command`.
- **The helper scripts checked a removed endpoint**, `/api/state`, and only "worked" because `curl -s` treats a 404 page as success. Fixed.
- **Performance, documented in REVIEW.md:** the dashboard re-reads the entire snapshot log every 3 seconds. After a week that is about 79 MB parsed in about half a second, on the same thread that polls the market.
- **Security, documented in REVIEW.md:** any website the owner visits could change the app's settings through a plain-text form post. Confirmed by doing it.
- **Two older test files** targeted the previous model's interface and no longer ran. Their most valuable checks (no look-ahead, the betting gates) were rebuilt as `test/safety.test.js`.
- **The model test suite was flaky**, failing about 1 run in 20. It was made deterministic with a seeded random generator, and its sample size raised so it is not borderline.

## 12. The power analysis that overturned the plan

Making that test reliable raised a question: how much data does gate 1 actually need? Measured across hundreds of seeded simulations (`tools/experiments/power.js`):

- At **2,000 rounds**, gate 1 detected a planted **15-point** edge **0 times out of 60**. At 4,000 rounds, 95%. At 6,000, 100%.
- It **never** raised a false alarm on a fair market, in any configuration.
- The cause is that the volatility-scaled move input is so small (about 0.09 on average) that the model's weight on it climbs far too slowly. A burn-in period did not help.
- Removing one division by 4 lifts detection at 2,000 rounds to 80%, still with no false alarms.
- Edges of 8 points or less were not detected within any tested timeframe, with or without the change.

So the agreed "stop after 2,000 rounds" rule would have abandoned even a huge real edge. It is retracted. The scaling change is documented as the top recommendation in REVIEW.md rather than applied, because it changes what an existing trained `model.json` means.
