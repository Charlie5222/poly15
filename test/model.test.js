'use strict';
/** full.test.js — exercise the model, gates, and scoring end to end. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paper = require('../paper');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-'));
const COEF = 0.0695;
// Seeded so every run is identical and a reviewer can reproduce any result.
// Override with SEED=n to explore other draws.
const SEED = Number(process.env.SEED || 20261028);
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = mulberry32(SEED);
const ROUNDS = Number(process.env.ROUNDS || 6000);   // 4000 detects a planted 15-point edge only ~95% of the time; see docs/MODEL.md
const BIAS = Number(process.env.BIAS || 0.15);
const STAKE = 10;

// --- the anchor property ---
{
  const m = new paper.Model(path.join(tmp, 'a.json'));
  for (const mk of [0.2, 0.35, 0.5, 0.65, 0.9]) {
    const snap = { horizon: 15, secsToClose: 60, priceToBeat: 81000, spot: 81050,
      yesQuote: mk, noQuote: 1 - mk, feeCoefficient: COEF, ts: new Date().toISOString() };
    const f = paper.features(snap, 25);
    assert.ok(Math.abs(m.prob(f, mk) - mk) < 1e-9, `untrained model must echo the market at ${mk}`);
  }
  console.log('anchors to market       OK');
}

// --- stake accounting ---
{
  const px = 0.40, fee = paper.takerFeePerShare(px, COEF);
  const shares = STAKE / (px + fee);
  const win = paper.score({ side: 'UP', price: px, fee, shares, stake: STAKE }, 1);
  const lose = paper.score({ side: 'UP', price: px, fee, shares, stake: STAKE }, 0);
  assert.ok(Math.abs(lose.pnl + STAKE) < 1e-9, 'a loss costs exactly the stake');
  assert.ok(Math.abs(win.pnl - (shares - STAKE)) < 1e-9);
  // At a fair price the pair must lose exactly the fee's worth.
  const fair = (win.pnl * px) + (lose.pnl * (1 - px));
  assert.ok(fair < 0, `fair-odds expectation must be negative, got ${fair}`);
  console.log('stake accounting        OK  (fair-odds EV ' + fair.toFixed(4) + ' per $' + STAKE + ')');
}

function simulate({ rounds, efficient, bias = 0 }) {
  const m = new paper.Model(path.join(tmp, 'm' + Math.random() + '.json'));
  const scored = [];
  for (let i = 0; i < rounds; i++) {
    const ptb = 81000, drift = (rng() - 0.5) * 300, spot = ptb + drift;
    const implied = 0.35 + rng() * 0.30;
    const trueP = efficient ? implied
      : Math.min(0.95, Math.max(0.05, implied + (drift > 0 ? bias : -bias)));
    const snap = {
      horizon: i % 2 ? 15 : 5, secsToClose: 60, priceToBeat: ptb, spot,
      momentum: (rng() - 0.5) * 2,
      yesQuote: implied + 0.01, noQuote: 1 - implied,
      feeCoefficient: COEF, ts: new Date(Date.now() + i * 60000).toISOString(),
    };
    const made = paper.makePredictions(snap, 40, m, STAKE);
    const resolvedUp = rng() < trueP ? 1 : 0;           // outcome drawn AFTER
    for (const p of made.predictions) {
      scored.push({ strategy: p.strategy, price: p.price, fee: p.fee, stake: p.stake,
        modelProb: p.modelProb ?? null, ...paper.score(p, resolvedUp) });
    }
    m.train(made.features, made.marketProb, resolvedUp);
  }
  return { sum: paper.summarize(scored), model: m, scored };
}

// --- efficient market: nothing wins, and gate 1 must not claim victory ---
{
  const { sum, model } = simulate({ rounds: ROUNDS, efficient: true });
  const fp = sum.filter((r) => r.verdict === 'POSITIVE');
  assert.strictEqual(fp.length, 0, `false profit: ${fp.map((x) => x.strategy).join(', ')}`);
  const b = model.benchmark();
  assert.ok(!b.beatsMarket, `gate 1 falsely passed on an efficient market (edge ${b.edge})`);
  console.log('efficient mkt: no win   OK  (gate 1: ' + b.verdict + ')');
}

// --- real edge: gate 1 must find it ---
{
  const { sum, model } = simulate({ rounds: ROUNDS, efficient: false, bias: BIAS });
  const b = model.benchmark();
  assert.ok(b.beatsMarket, `gate 1 missed a real edge (edge ${b.edge}, se ${b.stderr})`);
  const winners = sum.filter((r) => r.verdict === 'POSITIVE');
  assert.ok(winners.length > 0, 'no strategy found a planted edge');
  console.log('real edge: detected     OK  (gate 1: ' + b.verdict + ', edge ' + b.edge.toFixed(4) + ')');
}

// --- calibration buckets behave ---
{
  const rows = [];
  for (let i = 0; i < 600; i++) {
    const p = 0.5 + rng() * 0.5;
    rows.push({ modelProb: p, won: rng() < p });
  }
  const cal = paper.calibration(rows);
  assert.strictEqual(cal.length, 5);
  for (const c of cal) if (c.n > 30) {
    assert.ok(Math.abs(c.actual - c.claimed) < 0.15, `bucket ${c.lo} badly off: ${c.actual} vs ${c.claimed}`);
  }
  console.log('calibration buckets     OK');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nall tests passed');
