# The model, the strategies, and how results are judged

This describes **model v2** (October 2026). v1, an online gradient-descent model, is described at the end along with why it was replaced. A v1 `model.json` is ignored on load and the model starts fresh.

## The core idea: correct the market, don't replace it

The market's price is already a prediction. If Yes trades around 58¢, the market says roughly a 58% chance of Up, and people with faster data than this app are setting that price. So the model does not predict the outcome from nothing. It predicts **how far to move away from the market's own probability**:

```
logit(p_model) = logit(p_market) + b + Σ wₖ · zₖ
```

where `logit(p) = ln(p / (1 − p))`, `p_market` is the midpoint of the quotes, and `z` is the standardized feature vector below.

When nothing has been learned, `b` and every `w` are zero, so `p_model = p_market` exactly (checked to nine decimal places in `test/model.test.js`). A model that reproduces the market has nothing to disagree with, so it places no edge bets. **Its failure mode is silence.** You have to earn a bet; you never have to stop a bad one.

## Features

Nine inputs in natural units. The model standardizes each one (subtracts its mean and divides by its standard deviation over the training rows) before fitting, so no input is too small to learn from. That scaling problem was v1's main flaw. The market probability is deliberately **not** a feature: it enters as the offset above.

| key | meaning | computed as |
|---|---|---|
| `distZ` | how many "normal moves for the time left" BTC sits from the opening price | `(spot − open) / (σ · √secsLeft)`, clipped to ±6 |
| `fairGap` | how far a pure random walk's odds are from the market's | `logit(Φ(distZ)) − logit(p_market)` |
| `momentum` | BTC's move over the last 30 seconds, in normal-move units | `(spot − spot 30 s ago) / (σ · √Δt)` |
| `volLevel` | how volatile BTC is right now, relative to normal | `ln(σ / (0.05% of price per √s))` |
| `timeLeft` | fraction of the round remaining | `secsToClose / roundSeconds` |
| `spread` | how wide the quotes are | `|yesAsk − (1 − noAsk)|` |
| `isFifteen` | 15-minute vs 5-minute round | 1 or 0 |
| `hourSin`, `hourCos` | time of day, UTC, on a circle | `sin`, `cos` of `2π · hour / 24` |

`σ` is volatility in dollars per square-root second, computed from **timestamped** price points, so uneven sampling no longer distorts it. Prices come from **BRTI**, the index the market settles on, read from Polymarket US's own `/v1/asset-prices/history` endpoint at 1-second resolution. (v1 used Coinbase, a different price from the one that settles.)

Why `distZ` matters most: under a pure random walk, P(Up) = Φ(distZ). A $20 lead with 30 seconds left in a quiet hour is nearly decisive; the same lead with 10 minutes left in a wild hour is noise. `fairGap` is the same idea expressed as a disagreement with the market.

## Training

**A full refit after every settled round**, rather than one gradient step:

- ridge-penalized logistic regression with the market's logit as a fixed offset,
- solved exactly by Newton's method (a few iterations, a 10×10 linear system, well under a millisecond at this data size),
- penalty `RIDGE = 20` on the weights, not the bias, which shrinks the model toward "agree with the market" until the data clearly says otherwise,
- on every stored row, up to the most recent 20,000.

Each row is keyed `slug@entry` (for example `btc-updown-15m-2026-10-28-0345z@60`), so a round is learned **once per entry time** and never twice. Rows come from live rounds and, optionally, from backfilled history (see below), and the Model tab shows how many of each.

Lower ridge values were tested (`tools/experiments/power.js`) and detected planted edges **less** often, because the extra freedom fits noise in the early rounds. 20 was kept.

## The three gates

The real-money side stays locked until all three pass. All three are now computed.

### Gate 1: does the model out-predict the market?

For every settled round at the main entry time (60 s), the model records two log losses, using the probability it **published before the outcome existed**:

```
loss(q, y) = −[ y · ln q + (1 − y) · ln(1 − q) ]
d = market loss − model loss            (positive means the model did better)
```

**Burn-in:** rounds are only counted once the model has at least 200 training rows. Before that it is mostly noise, and its early losses only slow the test down.

**The test is sequential.** A fixed "three standard errors" rule is only valid if you look once. This app looks every few seconds, forever, and with enough looks noise eventually crosses any fixed line. Gate 1 instead uses a normal-mixture boundary (Robbins; de la Peña et al. 2004):

```
pass when  S ≥ √((V + ρ) · (ln((V + ρ)/ρ) + 2 ln(1/α)))
S = Σ d,  V = Σ d²,  α = 0.01,  ρ = 0.5
```

The chance of it **ever** passing on a model that is no better than the market stays below 1%, however often it is checked. `test/model.test.js` checks this by peeking after every round. ρ barely matters: values from 0.5 to 50 gave the same detection rates. It also needs at least 200 counted rounds.

### Gate 2: when it says 70%, does it win 70%?

The model's calls are bucketed by confidence (50–60%, … 90–100%). In each bucket with at least 20 calls, the actual win rate must be within **three standard errors** of the average confidence claimed. It passes with at least 200 calls and no bucket off. Three, not two and a half: five buckets are checked at once, and at 2.5 an honest model is flagged about 6% of the time.

### Gate 3: does it make money after fees?

`model_edge` must show positive paper profit after fees, judged by the same sequential test as the strategy verdicts below.

## How much data gate 1 needs

We plant an edge in simulated rounds: the market's price ignores BTC's move, while the true probability shifts by *E* points toward the move. Then we count how often gate 1 detects it, and how often it falsely passes on a fair market. Each cell is 20 seeded trials, refitting after every round as the app does. Reproduce with `node tools/experiments/power.js --rounds R --edge E --seeds 20 --refit 1`.

| live rounds | about | 15-point edge, v2 | 8-point edge, v2 | false passes on a fair market | 15-point edge, v1 (for comparison) |
|---|---|---|---|---|---|
| 1,000 | 2.6 days | 20% | 0% | 0 of 40 | 0% |
| 1,500 | 3.9 days | 70% | 0% | 0 of 40 | not run |
| 2,000 | 5.2 days | **90%** | 0% | 0 of 40 | **0%** |
| 6,000 | 16 days | not needed | not run | | 100% |

**Gate 1 never once passed on a fair market**, in any configuration tested. It is trustworthy when it says yes.

**What this means in practice.** About 384 rounds settle per day (both horizons), so 2,000 rounds is about 5 days of recording. **Backfilling history** (next section) supplies training rows immediately, so the burn-in is skipped. But gate 1 itself is scored only on live predictions, so live recording time is still what it waits for. Realistic edges, if any exist, are probably a few points, and those are not detectable in weeks. That is a property of near-coin-flip outcomes, not of the code.

## History and the backtest

`history.js` rebuilds past rounds from Polymarket US's own endpoints:

- `/v1/price-history?symbol=cpc-…&fidelity=1`: the Yes and No asks each minute. A point stamped *t* is the price at *t + 60 s*, which was verified against recorded snapshots and is corrected for.
- `/v1/asset-prices/history`: BRTI at 1-second and 1-minute resolution.
- `/v1/events?slug=…`: the official open price and settlement.

About four weeks are available. The backfill is rate-limited (4 requests per second), resumable (one line appended per round to `data/history/rounds-{15,5}m.jsonl`), and runs hourly to keep up.

The **backtest** replays those rounds walk-forward. For each round in time order it builds the snapshot as it would have looked at 120 s and 60 s before close, predicts with a model trained **only on earlier rounds**, scores, and only then adds the round to the model. Results appear on the Results tab under "Backtest". Their limits:

- History has the best asks but not the order book, so backtest taker fills assume unlimited size at the ask. They are optimistic for large stakes.
- Minute resolution means 30 s entries cannot be backtested, and a quote can be up to 30 s old at entry.
- Maker fills are judged on minute points only, so they are a rough guide, and only the 120 s entry has a later point before the close to fill on.

**First backtest finding (about 1,300 rounds, 1–15 October 2026):** no taker strategy beat its breakeven; the favourite-following ones came within 1 to 2 points of it. The maker orders filled about 13% of the time and then won only about 35% against a breakeven near 74%. They got filled almost exclusively when the price was moving against them. That is adverse selection, and it is the main reason "makers pay no fee" is not free money.

International Polymarket was considered as a stand-in source and turned out to be unnecessary once these US endpoints were found.

## Strategies

Every round, each strategy picks a side at three entry times: **120, 60 and 30 seconds** before close. 60 s is the main one used for gates; the Results tab can filter by entry.

| strategy | rule | why it is here |
|---|---|---|
| `always_up` / `always_down` | always Up / always Down | baselines, mirror images |
| `follow_book` | the side the market favours | does the favourite win often enough to cover its price? |
| `fade_book` | the side the market disfavours | the underdog |
| `momentum` | the side of the open BTC is on now | the most intuitive idea |
| `fade_move` | the other side | mean reversion |
| `late_favorite` | the favourite, **only** when it costs 80–97¢ | wins often, wins little; is the favourite underpriced? |
| `model_direction` | the side the model thinks likelier | the model's raw opinion, every round |
| `model_edge` | the model's side, **only** when earned | the one that would matter |
| `follow_book_maker` | like `follow_book`, as a resting limit order at the bid | makers pay no fee |
| `model_direction_maker` | like `model_direction`, as a resting limit order at the bid | same |

`model_edge` bets only when all of these hold:

1. at least 200 training rows,
2. **informative**: over recent predictions the model's disagreement with the market has a standard deviation of at least 0.02 (a constant disagreement is a bias, not a signal),
3. its belief beats the side's breakeven by at least 2 points: `p > price + fee + 0.02`.

`test/safety.test.js` covers an untrained model, a trained but flat model, and a model with too few rounds; none may bet.

### The BUY UP / BUY DOWN call

Each round card on the Now tab answers two separate questions, built by `callFrom()` in `paper.js`:

1. **Who is likely to win:** "BUY DOWN · 93% likely to win", on the side the model thinks likelier.
2. **Is the price worth it:** "✓ Good price: worth 75¢, you pay 69¢" only when `model_edge` bets that side, otherwise "✗ Too expensive: worth 87¢, you pay 91¢".

These are different questions. A side that wins 93% of the time but costs 95¢ loses money over many rounds. A side that wins 40% of the time at 30¢ makes money. When the good price is on the less likely side, the call stays on the likelier side and a note says "Good price on UP (underdog, wins ~40%…)".

**While the model is learning** (under 200 rounds, or not yet informative) its own numbers are noise. The call is then the market's favourite at the market's odds, labelled "Learning (N of 200 rounds): this is just the market's odds". There is no price verdict then.

After learning, until gate 1 passes, every call also carries an **Unproven** badge ("7 of 200 live rounds checked"). Training on backfilled history lets the model give its own opinion early, but only live rounds can show that opinion beats the market.

The call updates live during the round and is **locked** to the latest bet placed once an entry time (120/60/30 s) passes. `test/safety.test.js` checks all four cases.

### Fills

**Taker bets walk the real order book** (`/v1/markets/{slug}/book`), fetched at entry. Buying Up consumes Yes offers; buying Down consumes Yes bids, converted to No prices. The stake is spent level by level until it runs out, and if the book is too thin the bet is for what was available. The average price paid, the fee per level, and the levels used are recorded.

**Maker orders** rest at the bid of their side. They count as filled only if a **later** snapshot in the same round shows that side's ask trading *below* the bid, so someone must have sold through it. Unfilled orders are recorded with `filled: false` and excluded from P&L. The Results tab shows each maker strategy's fill rate. This is still optimistic about queue position, so treat maker results as an upper bound.

## Bets and scoring

A taker bet spends at most the stake, fee included:

```
shares = Σ over levels of qty bought
pnl    = (won ? shares : 0) − (cost + fees)
```

At fair odds this loses on average: at 50¢ a $10 bet loses about 34¢ to the fee.

Outcomes come from the official settlement (`settlementPrice` ≥ open), or from `outcomePrices` only when the market status is `RESOLVED` or `SETTLED`. A re-check of all v1 data against the official settlement found **73 of 366** recorded outcomes wrong, because v1 read `outcomePrices` while rounds were still trading. Those have been corrected (`outcomes-checked.jsonl` records each re-check).

## Verdicts

Each strategy on the Results tab is labelled:

| label | meaning |
|---|---|
| too few | under 100 filled bets |
| noise | the sequential test has not decided |
| POSITIVE / negative | the sequential test passed for profit (or loss) per dollar staked |

The test is the same anytime-valid boundary as gate 1, at `α = 0.05 / k` for `k` strategies (a Bonferroni correction), so looking at the screen many times a day with eleven strategies does not manufacture a winner.

Results default to **v2 data only**. v1 bets used event-level quotes that went stale or one-sided in the final minute (one side null, the other at 1¢ or 99¢), so $10 "bought" at 1¢ could pay about $990. Those results are not believable and are hidden unless "Include v1" is selected.

## Test sessions

A session is a time window with a pretend bankroll. Every bet placed inside it counts, re-expressed at the session's stake, and the report is rebuilt from the recorded bets, so a restart loses nothing. While one runs the app keeps the Mac awake (`caffeinate -ims`), polls every 3 seconds in each round's last 2½ minutes, and records 1-second prices from Coinbase, Kraken and Binance.US next to BRTI (`data/feeds/`).

**Every-minute test** (`ladder.js`, `data/ladder.jsonl`). During a session, at each whole minute left (14m to 1m on 15m rounds, 4m to 1m on 5m rounds) the BUY call and the market's favourite are written down as pretend bets. They never count in the session totals and the model never learns from them. The report shows win rate vs break-even and profit per minute. With ~18 minutes tested, the best one is flagged as "Promising" only at z ≥ 3; otherwise it is labelled as possibly luck. A market-only backtest over ~4,600 past rounds found the favourite loses at every minute except 1 minute left on 15m rounds (+$95 on 2,606 bets).

**Exchange gap test** (`gapReport` in `ladder.js`). The BRTI feed behaves like a rolling average of about a minute: 1-second exchange moves match its moves about equally at lags of 0 to 45 seconds and not at all from 60. It is still the settlement price: over about 4,800 past rounds its last value is within about $0.23 of the settlement and gives the right winner 99.8%+ of the time. So the gap between the exchanges (average of three) and BRTI forecasts where BRTI is going, and on the first night the market only partly priced that. The rule below was fitted to that one night, so nights from 2026-10-30 are its test: at each whole minute left and at 30 seconds, if the gap is $20 or more, pretend-bet the way it points at the book price, skipping prices above 97¢. Not in session totals and not trained on. It passes with a profit and z ≥ 2 counted per round, because bets in one round move together.

The report slices the BUY call's bets by entry time, round length, side, price paid, price verdict, model vs market, volatility, distance from the line and time of night. A slice becomes a finding at 15+ bets; "promising" means its profit is 2+ standard errors from zero, and with ~25 slices about one will reach that by luck. Whether the call flipped is shown but never a finding, since it is only known after the round. The lead check correlates each exchange's 1-second move k seconds earlier with BRTI's move now; the best k is its head start. Sell-on-flip values a held bet at the bid recorded at the next check, minus the taker fee.

## Appendix: model v1, and why it was replaced

v1 took one stochastic gradient step per round with a decaying learning rate (`0.10 / (1 + n/1200)`) on hand-scaled features. Its main input averaged about 0.09, so the weight needed for a 15-point edge (about 6.7) was reached far too slowly: gate 1 detected that edge 0 times in 60 at 2,000 rounds, and needed about 6,000. A full refit on standardized features removes the learning-speed problem entirely.
