'use strict';
/**
 * power.js: how often does gate 1 detect a real edge, and how often does it
 * claim one that isn't there?
 *
 * Simulates rounds where the market's price ignores a real signal (BTC's move
 * since the open) by EDGE probability points, trains a model on them, and
 * checks whether gate 1 passes. Repeats over many seeds. Also runs the same
 * number of rounds on an efficient market, where gate 1 must never pass.
 *
 *   node tools/experiments/power.js --rounds 2000 --edge 0.15 --seeds 40
 *   node tools/experiments/power.js --paper ./some/other/paper.js ...
 *
 * Deterministic for a given seed range.
 */
const os = require('os');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ROUNDS = Number(arg('rounds', 2000));
const EDGE = Number(arg('edge', 0.15));
const SEEDS = Number(arg('seeds', 40));
const paper = require(path.resolve(arg('paper', path.join(__dirname, '../../paper.js'))));

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function trial(seed, edge) {
  const rng = mulberry32(seed);
  const m = new paper.Model(path.join(os.tmpdir(), `poly15-power-${process.pid}-${seed}-${edge}.json`));
  for (let i = 0; i < ROUNDS; i++) {
    const ptb = 81000, drift = (rng() - 0.5) * 300, spot = ptb + drift;
    const implied = 0.35 + rng() * 0.30;
    const trueP = Math.min(0.95, Math.max(0.05, implied + (drift > 0 ? edge : -edge)));
    const snap = {
      horizon: i % 2 ? 15 : 5, secsToClose: 60, priceToBeat: ptb, spot, momentum: (rng() - 0.5) * 2,
      yesQuote: implied + 0.01, noQuote: 1 - implied, feeCoefficient: 0.0695,
      ts: new Date(Date.UTC(2026, 9, 28) + i * 60000).toISOString(),
    };
    const made = paper.makePredictions(snap, 40, m, 10);
    m.train(made.features, made.marketProb, rng() < trueP ? 1 : 0);   // outcome drawn after
  }
  return { passed: !!m.benchmark().beatsMarket, moveZ: m.w.moveZ };
}

let hits = 0, falsePos = 0;
for (let s = 1; s <= SEEDS; s++) {
  if (trial(s, EDGE).passed) hits++;
  if (trial(100000 + s, 0).passed) falsePos++;
}
console.log(`rounds=${ROUNDS} planted edge=${EDGE}  detected ${hits}/${SEEDS}  false positives ${falsePos}/${SEEDS}`);
