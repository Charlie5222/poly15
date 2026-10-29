'use strict';
/** model.test.js: the model, its gates and the statistics, end to end. Offline. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paper = require('../paper');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-'));
const COEF = 0.0695;
// Seeded so every run is identical and a reviewer can reproduce any result.
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
const ROUNDS = Number(process.env.ROUNDS || 3000);
const BIAS = Number(process.env.BIAS || 0.15);
const STAKE = 10;

// --- the anchor property: an empty model is the market ---
{
  const m = new paper.Model(null);
  for (const mk of [0.2, 0.35, 0.5, 0.65, 0.9]) {
    const snap = { horizon: 15, secsToClose: 60, priceToBeat: 81000, spot: 81050,
      yesQuote: mk + 0.005, noQuote: 1 - mk + 0.005, feeCoefficient: COEF, ts: new Date().toISOString() };
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
  const fair = (win.pnl * px) + (lose.pnl * (1 - px));
  assert.ok(fair < 0, `fair-odds expectation must be negative, got ${fair}`);
  console.log('stake accounting        OK  (fair-odds EV ' + fair.toFixed(4) + ' per $' + STAKE + ')');
}

// --- the fit recovers a known signal ---
{
  const m = new paper.Model(null);
  const r = mulberry32(7);
  for (let i = 0; i < 2000; i++) {
    const f = Object.fromEntries(paper.FEATURE_KEYS.map((k) => [k, (r() - 0.5) * 2]));
    const mkt = 0.3 + r() * 0.4;
    const p = paper.sigmoid(paper.logit(mkt) + 1.2 * f.momentum);
    m.add('k' + i, f, mkt, r() < p ? 1 : 0, { refit: false });
  }
  m.fit();
  const w = m.w;
  const top = Object.entries(w).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0][0];
  assert.strictEqual(top, 'momentum', `largest weight should be momentum, got ${top}`);
  assert.ok(w.momentum > 0.3, `momentum weight too small: ${w.momentum}`);
  assert.ok(m.isInformative(), 'a model with a real signal should read as informative');
  // The same row twice is learned once.
  assert.strictEqual(m.add('k0', {}, 0.5, 1), false);
  // Saves and reloads to the same predictions.
  const file = path.join(tmp, 'm.json');
  m.file = file; m.save();
  const back = new paper.Model(file);
  const f = Object.fromEntries(paper.FEATURE_KEYS.map((k) => [k, 0.5]));
  assert.ok(Math.abs(back.prob(f, 0.5) - m.prob(f, 0.5)) < 1e-4, 'reloaded model disagrees');
  console.log('fit recovers signal     OK  (momentum ' + w.momentum.toFixed(3) + ' per sd)');
}

// --- a v1 model file is ignored, which is the reset ---
{
  const file = path.join(tmp, 'v1.json');
  fs.writeFileSync(file, JSON.stringify({ w: { moveZ: 3 }, b: 0.4, trained: 500 }));
  const m = new paper.Model(file);
  assert.strictEqual(m.trained, 0);
  assert.strictEqual(m.b, 0);
  console.log('v1 model ignored        OK');
}

function simulate({ rounds, efficient, bias = 0 }) {
  const m = new paper.Model(null);
  const scored = [];
  for (let i = 0; i < rounds; i++) {
    const ptb = 81000, drift = (rng() - 0.5) * 300, spot = ptb + drift;
    const implied = 0.35 + rng() * 0.30;
    const trueP = efficient ? implied
      : Math.min(0.95, Math.max(0.05, implied + (drift > 0 ? bias : -bias)));
    const snap = {
      horizon: i % 2 ? 15 : 5, secsToClose: 60, priceToBeat: ptb, spot,
      momentum: (rng() - 0.5) * 2,
      yesQuote: implied + 0.005, noQuote: 1 - implied + 0.005,
      feeCoefficient: COEF, ts: new Date(Date.UTC(2026, 9, 28) + i * 60000).toISOString(),
    };
    const made = paper.makePredictions(snap, 40, m, STAKE);
    const resolvedUp = rng() < trueP ? 1 : 0;           // outcome drawn AFTER
    for (const p of made.predictions) {
      scored.push({ strategy: p.strategy, price: p.price, fee: p.fee, stake: p.stake, shares: p.shares,
        modelProb: p.modelProb ?? null, ...paper.score(p, resolvedUp) });
    }
    m.recordOutOfSample('r' + i, made.modelProb, made.marketProb, resolvedUp);
    m.add('r' + i, made.features, made.marketProb, resolvedUp, { refit: i % 50 === 49 });
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

// --- real edge: gate 1 must find it, and the edge strategy must profit ---
{
  const { sum, model } = simulate({ rounds: ROUNDS, efficient: false, bias: BIAS });
  const b = model.benchmark();
  assert.ok(b.beatsMarket, `gate 1 missed a real edge (edge ${b.edge}, progress ${b.progress})`);
  const winners = sum.filter((r) => r.verdict === 'POSITIVE').map((r) => r.strategy);
  assert.ok(winners.length > 0, 'no strategy found a planted edge');
  console.log('real edge: detected     OK  (gate 1: ' + b.verdict + '; profitable: ' + winners.join(', ') + ')');
}

// --- the sequential test: valid under constant peeking ---
{
  // Pure noise, checked after every single observation, many times over:
  // it should almost never pass.
  let falsePass = 0;
  const TRIALS = 200;
  for (let t = 0; t < TRIALS; t++) {
    const r = mulberry32(1000 + t);
    const xs = [];
    let passed = false;
    for (let i = 0; i < 2000 && !passed; i++) {
      xs.push((r() - 0.5) * 2);
      if (i % 10 === 0 && paper.seqTest(xs, { alpha: 0.05, rho: 10 }).pass) passed = true;
    }
    if (passed) falsePass++;
  }
  assert.ok(falsePass / TRIALS <= 0.05, `peeking broke the test: ${falsePass}/${TRIALS} false passes`);
  // A real positive mean gets found.
  const r = mulberry32(5);
  const xs = Array.from({ length: 2000 }, () => (r() - 0.5) * 2 + 0.15);
  assert.ok(paper.seqTest(xs, { alpha: 0.05, rho: 10 }).pass, 'missed a real effect');
  console.log('sequential test         OK  (' + falsePass + '/' + TRIALS + ' false passes while peeking)');
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
  for (const c of cal) if (c.n > 30) assert.ok(c.ok, `honest bucket ${c.lo} flagged: ${c.actual} vs ${c.claimed}`);
  assert.ok(paper.calibrationGate(rows).pass, 'honest forecasts should pass gate 2');
  const liar = rows.map((r) => ({ modelProb: r.modelProb, won: rng() < 0.5 }));
  assert.ok(!paper.calibrationGate(liar).pass, 'overconfident forecasts must fail gate 2');
  console.log('calibration buckets     OK');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nall tests passed');
