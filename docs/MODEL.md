# The model, the strategies, and how results are judged

## The core idea: correct the market, don't replace it

The market's price is already a prediction. If Yes trades around 58¢, the market says roughly a 58% chance of Up. Plenty of people with faster data than this app are setting that price. So the model does not try to predict the outcome from nothing. It predicts **how far to move away from the market's own probability**:

```
logit(p_model) = logit(p_market) + b + Σ wₖ · xₖ
```

where `logit(p) = ln(p / (1 − p))`, `p_market` is the midpoint of the quotes, and `x` is the feature vector below.

When nothing has been learned, `b` and every `w` are zero, so `p_model = p_market` exactly (verified to nine decimal places in `test/model.test.js`). A model that reproduces the market has nothing to disagree with, so it places no edge bets. **Its failure mode is silence.** You have to earn a bet; you never have to stop a bad one.

## Features

Eight inputs, each scaled to roughly −1…1 so no single one dominates a gradient step. The market probability is deliberately **not** a feature: it enters as the offset above, so the model cannot simply learn to lean on it.

| key | meaning | computed as |
|---|---|---|
| `moveZ` | how far BTC has moved since the round opened, in units of how far it normally moves in that time | `(spot − open) / (vol · √(elapsed / 15))`, clipped to ±4, then divided by 4 |
| `momentum` | which way BTC moved since the previous snapshot | `(spot − previous spot) / vol`, clipped to ±4, divided by 4 |
| `vol` | how volatile BTC is right now | recent volatility relative to 0.05% of the price, clipped to 0…3, divided by 3 |
| `timeLeft` | fraction of the round remaining at entry | `secsToClose / roundSeconds` |
| `spread` | how wide the quotes are | `|yesAsk − (1 − noAsk)| × 4` |
| `isFifteen` | 15-minute vs 5-minute round | 1 or 0 |
| `hourSin`, `hourCos` | time of day, UTC, on a circle so 23:00 sits next to 00:00 | `sin`, `cos` of `2π · hour / 24` |

`vol` is the standard deviation of BTC's change between consecutive spot samples, in dollars, over up to the last 240 samples. Spot comes from Coinbase; settlement uses BRTI. See REVIEW.md for both of those as known issues.

Why `moveZ` matters most: a $20 move is a strong signal in a quiet hour and noise in a wild one. Dividing by expected movement lets the model tell those apart.

## Training

Online logistic regression, one stochastic gradient step per settled round:

```
p   = sigmoid(logit(p_market) + b + Σ wₖ xₖ)
err = p − y                     (y = 1 if the round settled Up)
wₖ ← wₖ − lr · (err · xₖ + l2 · wₖ)
b  ← b  − lr · err
lr  = 0.10 / (1 + trained / 1200)
l2  = 3 × 10⁻⁵
```

Confident mistakes move the weights more than hedged ones. The learning rate shrinks as rounds accumulate, so early rounds can move it quickly and later ones cannot undo hundreds of rounds of evidence.

Training happens **after** a round's bets are scored and **once per round**, enforced by the set of already-scored slugs.

## The three gates

The Live tab stays locked until all three pass. Only the first is computed today.

### Gate 1: does the model out-predict the market?

For every settled round the model records two log losses, its own and the market's:

```
loss(q, y) = −[ y · ln q + (1 − y) · ln(1 − q) ]
```

Lower is better. Gate 1 takes the per-round difference `market loss − model loss` over the last 3,000 rounds and passes only if the mean difference exceeds **three standard errors**. Under 200 rounds it reports "too few".

This is the honest test. A model that cannot out-predict the price it is betting against has nothing to bet on, whatever its win rate looks like.

### Gate 2: when it says 70%, does it win 70%?

Predictions are bucketed by confidence (50–60%, 60–70%, … 90–100%) and the actual win rate is shown for each bucket. **Not yet automated**: the server always reports this gate as not passed, and the table is shown for a human to judge.

Early on, while the model still equals the market, this table is effectively measuring the **market's** calibration, which is interesting in its own right.

### Gate 3: does it make money after fees?

Only meaningful once 1 and 2 pass. **Not yet automated.**

## How much data the gate needs

This is the most important result in the repo, and it changes how the experiment should be run.

We planted an edge in simulated rounds: the market's price ignores BTC's move, while the true probability shifts by *E* points in the direction of the move. Then we asked how often gate 1 detects it. Each cell is out of 40 to 60 seeded trials. Reproduce any cell with `node tools/experiments/power.js --rounds R --edge E --seeds 40`.

| rounds | planted edge | detected (current code) | detected (`moveZ` not divided by 4) | false alarms on a fair market |
|---|---|---|---|---|
| 1,000 | 15 pts | 0% | 10% | 0% |
| 2,000 | 15 pts | **0%** | **80%** | 0% |
| 4,000 | 15 pts | 95% | not run | 0% |
| 6,000 | 15 pts | 100% | not run | 0% |
| 2,000 | 8 pts | 0% | 0% | 0% |
| 4,000 | 8 pts | 0% | not run | 0% |
| 4,000 | 5 pts | not run | 0% | 0% |

Across every configuration tested, **gate 1 never once claimed an edge on a fair market.** It is trustworthy when it says yes. It is slow to say yes.

**Why it is slow.** The `moveZ` input averages only about 0.09 in size. To express a 15-point edge, the model's weight on it needs to reach roughly 6.7. After 10,000 rounds the weight has only reached about 2.5, while the learning rate has decayed to a tenth of its starting value. The model learns the right thing, too slowly to matter. A burn-in that excludes early rounds from the benchmark did **not** help (0% at 2,000 rounds for every burn-in tried), which rules out "the early rounds dilute the average" as the cause.

**What this means.**

1. The rule proposed earlier in this project, *stop if gate 1 has not passed after 2,000 rounds*, is **wrong**. It would abandon even a very large real edge every time.
2. Removing the `/ 4` on `moveZ` is a one-line change that makes large edges detectable at about 2,000 rounds, with no rise in false alarms. Applying it changes the meaning of an existing `model.json`, so the model should be reset when it is applied.
3. **Realistic edges are probably out of reach.** A 15-point edge is enormous. If an edge exists in these markets at all, it is likely a few points, and neither version detects 5 or 8 points within weeks of data. At about 384 rounds a day, 6,000 rounds is about 16 days.

## Strategies

Every round, each strategy picks a side at the price actually on offer, about 60 seconds before close.

| strategy | rule | why it is here |
|---|---|---|
| `always_up` | always Up | baseline |
| `always_down` | always Down | baseline. With `always_up`, it is a mirror image: exactly one of them wins every round |
| `follow_book` | the side the market favors | does the favorite win often enough to cover its price? |
| `fade_book` | the side the market disfavors | the underdog |
| `momentum` | the direction BTC has moved since the open | the most intuitive idea |
| `fade_move` | against that direction | mean reversion |
| `model_direction` | the side the model thinks more likely | tracks the model's raw opinion, every round |
| `model_edge` | the model's side, **only** when it has earned it | the one that would matter |

`model_edge` bets only when all of these hold:

1. the model has trained on at least 200 settled rounds,
2. it is **informative**: over its last 300 predictions, its disagreement with the market (`p_model − p_market`) has a standard deviation of at least 0.02. A model whose disagreement is constant has found a bias, not a signal,
3. its belief in a side exceeds that side's breakeven win rate by at least 2 points: `p > price + fee + 0.02`.

Two early versions failed without those guards. An untrained model sitting at exactly 50% "found edge" on any side priced under 50¢, which is just always buying the underdog. Then a trained but flat model did the same. `test/safety.test.js` covers both.

## Bets and scoring

Each bet spends exactly the stake (default $10) including the fee:

```
shares = stake / (price + fee)
pnl    = (won ? shares : 0) − stake
```

So a loss always costs exactly the stake, and a win pays `shares − stake`. At fair odds this loses on average. At a fair 50¢ a $10 bet loses about 34¢ on average to the fee.

Fills are assumed at the quoted price for any size. There is no order book depth or slippage. See REVIEW.md.

## Verdicts

The Paper tab labels each strategy:

| label | meaning |
|---|---|
| too few | under 100 settled bets |
| noise | average profit per bet within three standard errors of zero |
| POSITIVE / negative | outside three standard errors |

**Why three, not the usual two.** Eight strategies are judged side by side. With a two-standard-error rule, at least one of eight pure coin flips gets labelled POSITIVE about 4% of the time. At three, about 0.3%.

The overall win rate on the Paper tab is shown twice: across all strategies, and without `always_up` and `always_down`. The two baselines are mirror images, so including both pulls any overall average toward 50% regardless of what the other strategies do.
