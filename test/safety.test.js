'use strict';
/**
 * safety.test.js: the properties that keep paper results honest.
 *
 *   1. No look-ahead: a prediction cannot depend on the round's outcome.
 *   2. Missing data never produces NaN features.
 *   3. The model cannot bet until it has earned it: trained, informative,
 *      and confident past the breakeven price by a margin.
 *   4. A bet can never lose more than its stake.
 *   5. Small samples are labeled "too few", never a verdict.
 *
 * Offline. No network needed.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paper = require('../paper');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poly15-safety-'));
const freshModel = (name) => new paper.Model(path.join(tmp, name + '.json'));
const COEF = 0.0695;

const snap = (o = {}) => ({
  horizon: 15, secsToClose: 60, priceToBeat: 81000, spot: 81020, momentum: 0.2,
  yesPrice: 0.55, yesQuote: 0.56, noPrice: 0.44, noQuote: 0.45,
  feeCoefficient: COEF, ts: '2026-10-28T03:59:00Z', ...o,
});
const edgeBets = (made) => made.predictions.filter((p) => p.strategy === 'model_edge');

// 1. No look-ahead.
{
  const m = freshModel('leak');
  const a = paper.makePredictions(snap(), 12, m, 10);
  // Attach every outcome field the recorder ever sees, then predict again.
  const leaky = snap({ resolvedUp: 1, settlementPrice: 99999, won: true, outcomePrices: ['1', '0'] });
  const b = paper.makePredictions(leaky, 12, m, 10);
  const shape = (x) => x.predictions.map((p) => [p.strategy, p.side, p.price, p.shares]);
  assert.deepStrictEqual(shape(a), shape(b), 'outcome fields changed a prediction: look-ahead leak');
  for (const p of a.predictions) {
    for (const k of ['resolvedUp', 'won', 'pnl', 'settlementPrice']) {
      assert.ok(!(k in p), `prediction carries outcome field "${k}"`);
    }
  }
  console.log('no look-ahead leak       OK');
}

// 2. Missing data.
{
  const holes = [
    snap({ spot: null }), snap({ priceToBeat: null }), snap({ yesQuote: null, yesPrice: null }),
    snap({ noQuote: null, noPrice: null }), snap({ secsToClose: null }), snap({ momentum: null }),
    snap({ spot: null, priceToBeat: null, yesQuote: null, noQuote: null, yesPrice: null, noPrice: null }),
  ];
  for (const s of holes) {
    for (const vol of [null, 0, 12]) {
      const f = paper.features(s, vol);
      for (const k of paper.FEATURE_KEYS) assert.ok(Number.isFinite(f[k]), `${k} not finite`);
      const mp = paper.marketProb(s);
      assert.ok(mp > 0 && mp < 1, 'market probability out of range');
    }
  }
  console.log('missing data handled     OK');
}

// 3. The betting gates.
{
  // Untrained: sits out, however cheap a side looks.
  const untrained = freshModel('untrained');
  for (const no of [0.45, 0.30, 0.20, 0.10]) {
    const made = paper.makePredictions(snap({ yesQuote: 1 - no + 0.01, noQuote: no }), 12, untrained, 10);
    assert.strictEqual(edgeBets(made).length, 0, `untrained model bet at noQuote ${no}`);
  }

  // Trained but flat: it reproduces the market exactly, so it has nothing to
  // disagree with. Must read as uninformative and must not bet.
  const flat = freshModel('flat');
  flat.trained = paper.MIN_TRAINED;
  for (let i = 0; i < 80; i++) paper.makePredictions(snap({ spot: 80900 + i * 3 }), 12, flat, 10);
  assert.strictEqual(flat.isInformative(), false, 'flat model read as informative');
  assert.strictEqual(edgeBets(paper.makePredictions(snap(), 12, flat, 10)).length, 0, 'flat model bet');

  // Trained, informative and confident: takes a cheap side, and only with margin.
  const sharp = freshModel('sharp');
  sharp.trained = paper.MIN_TRAINED;
  sharp.w.moveZ = 5;
  for (let i = 0; i < 80; i++) {
    paper.makePredictions(snap({ spot: 81000 + (i % 2 ? 300 : -300) }), 10, sharp, 10);
  }
  assert.strictEqual(sharp.isInformative(), true, 'varied model should read as informative');
  const made = paper.makePredictions(snap({ spot: 81300, yesQuote: 0.30, noQuote: 0.71 }), 10, sharp, 10);
  const e = edgeBets(made);
  assert.strictEqual(e.length, 1, 'confident model should take one edge bet');
  assert.strictEqual(e[0].side, 'UP');
  assert.ok(e[0].modelProb > e[0].required + paper.EDGE_MARGIN, 'edge bet without the required margin');

  // Same model, fewer rounds: the trained gate alone must stop it.
  sharp.trained = paper.MIN_TRAINED - 1;
  const early = paper.makePredictions(snap({ spot: 81300, yesQuote: 0.30, noQuote: 0.71 }), 10, sharp, 10);
  assert.strictEqual(edgeBets(early).length, 0, 'bet before reaching MIN_TRAINED');
  console.log('betting gates            OK');
}

// 4. Losses are bounded by the stake.
{
  for (const px of [0.05, 0.3, 0.5, 0.7, 0.95]) {
    const fee = paper.takerFeePerShare(px, COEF);
    const bet = { side: 'UP', price: px, fee, shares: 10 / (px + fee), stake: 10 };
    const lose = paper.score(bet, 0), win = paper.score(bet, 1);
    assert.ok(Math.abs(lose.pnl + 10) < 1e-9, `loss at ${px} was ${lose.pnl}, not -10`);
    assert.ok(win.pnl > 0, `a win at ${px} should profit`);
  }
  console.log('loss bounded by stake    OK');
}

// 5. Honest labels.
{
  const rows = Array.from({ length: 99 }, () => ({ strategy: 'x', price: 0.5, fee: 0.017, stake: 10, won: true, pnl: 9.6 }));
  assert.strictEqual(paper.summarize(rows)[0].verdict, 'too few', '99 bets must read "too few"');
  console.log('honest small-sample label OK');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nall safety tests passed');
