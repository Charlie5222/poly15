'use strict';
/**
 * session.test.js: the overnight session report adds up.
 *
 *   1. Bankroll = start + every settled bet's profit, in time order.
 *   2. Only bets placed inside the session window count.
 *   3. A stake change mid-session cannot skew totals: bets are re-expressed at the session stake.
 *   4. Selling on a flip uses the bid for the side held, minus the fee.
 *   5. The exchange lead check finds a lead that is really there.
 *   6. A session survives a restart (it is saved to disk).
 *
 * Offline. No network needed.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paper = require('../paper');
const { Sessions, report, tally, curve, sellOnFlip } = require('../session');
const { Feeds, leadLag } = require('../feeds');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poly15-session-'));
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

ok('tally and curve add up', () => {
  const rows = [
    { won: true, pnl: 2, stake: 10, price: 0.8, fee: 0.01, endMs: 3, ts: 'c' },
    { won: false, pnl: -10, stake: 10, price: 0.8, fee: 0.01, endMs: 1, ts: 'a' },
    { won: true, pnl: 2, stake: 10, price: 0.8, fee: 0.01, endMs: 2, ts: 'b' },
  ];
  const t = tally(rows);
  assert.strictEqual(t.n, 3); assert.strictEqual(t.wins, 2);
  assert.ok(Math.abs(t.pnl + 6) < 1e-9); assert.ok(Math.abs(t.need - 0.81) < 1e-9);
  const c = curve(rows, 10000);
  assert.ok(Math.abs(c.end - 9994) < 1e-9);
  assert.ok(Math.abs(c.maxDrawdown - 10) < 1e-9, 'drawdown from the 10000 peak after the first loss');
  assert.strictEqual(c.longestWin, 2); assert.strictEqual(c.longestLoss, 1);
});

// A tiny fake world: two rounds, bets at 120s and 60s, one round outside the session.
const SLUG = (m) => `btc-updown-5m-2026-10-30-0${m}00`;
const parseSlug = (slug) => ({ endMs: Date.parse('2026-10-30T00:00:00Z') + Number(slug.slice(-3, -2)) * 60000 });
const bet = (strategy, side, price, extra = {}) => ({ strategy, side, price, fee: paper.takerFeePerShare(price, 0.0695), shares: 10 / (price + paper.takerFeePerShare(price, 0.0695)), stake: 10, ...extra });
function world() {
  const preds = new Map(), scored = [], rounds = new Map();
  const add = (slug, entry, ts, side, price, up, stake = 10, book = null) => {
    const md = bet('model_direction', side, price, { modelProb: 0.85, marketProb: side === 'UP' ? 0.8 : 0.2 });
    preds.set(`${slug}@${entry}`, { slug, entry, ts, modelVersion: 2, marketProb: side === 'UP' ? 0.8 : 0.2, modelTrained: 500, informative: true, predictions: [md], book, features: { distZ: 1 }, vol: 1 });
    const won = (side === 'UP') === (up === 1), k = stake / 10;
    scored.push({ slug, entry, ts, modelVersion: 2, strategy: 'model_direction', side, price: md.price, fee: md.fee, shares: md.shares * k, stake, won, pnl: ((won ? md.shares : 0) - 10) * k, horizon: 5 });
    rounds.set(slug, { resolvedUp: up });
  };
  add(SLUG(1), 120, '2026-10-30T00:00:00Z', 'UP', 0.8, 1);
  add(SLUG(1), 60, '2026-10-30T00:00:30Z', 'DOWN', 0.6, 1, 20, { bids: [{ px: 0.7 }], offers: [{ px: 0.72 }] });
  add(SLUG(2), 60, '2026-10-30T00:01:30Z', 'UP', 0.9, 0);
  add(SLUG(5), 60, '2026-10-29T20:00:00Z', 'UP', 0.9, 1);   // before the session
  return { preds, scored, rounds };
}
const statusOf = (rec) => ({ trained: rec.modelTrained, informative: rec.informative });
const model = { w: {} };

ok('only bets inside the session count, at the session stake', () => {
  const w = world();
  const sess = { startedAt: '2026-10-29T23:00:00Z', endedAt: null, bankroll: 10000, stake: 10 };
  const r = report(sess, { ...w, statusOf, model, parseSlug });
  assert.strictEqual(r.every.n, 3, 'the bet before the session is left out');
  // win +2.43ish, lose -10 (20 stake rescaled to 10), lose -10
  const expect = (10 / (0.8 + paper.takerFeePerShare(0.8, 0.0695)) - 10) - 10 - 10;
  assert.ok(Math.abs(r.every.pnl - expect) < 1e-6, `pnl ${r.every.pnl} vs ${expect}`);
  assert.ok(Math.abs(r.every.end - (10000 + expect)) < 1e-6);
  assert.strictEqual(r.rounds, 2);
  const flip = r.patterns.find((g) => g.id === 'flip');
  assert.ok(flip.rows.find((x) => x.label === 'Call flipped sides').n === 2);
  assert.ok(!r.findings.some((f) => f.group === 'Did the call change during the round'), 'flips are hindsight, not a finding');
});

ok('selling on a flip uses the bid for the side held', () => {
  const need = 0.8 + paper.takerFeePerShare(0.8, 0.0695), shares = 10 / need;
  const m = new Map([['s', [
    { entry: 120, call: { side: 'UP', stake: 10, need }, resolvedUp: 0 },
    { entry: 60, call: { side: 'DOWN', stake: 10, need: 0.5 }, book: { bids: [{ px: 0.3 }], offers: [{ px: 0.32 }] }, resolvedUp: 0 },
  ]]]);
  const s = sellOnFlip(m);
  assert.strictEqual(s.n, 1);
  assert.ok(Math.abs(s.holdPnl + 10) < 1e-9);
  const sell = shares * 0.3 - shares * paper.takerFeePerShare(0.3, 0.0695) - 10;
  assert.ok(Math.abs(s.sellPnl - sell) < 1e-9);
});

ok('lead check finds a 3 second lead', () => {
  const f = new Feeds(tmp);
  let px = 80000, rnd = 7;
  const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647 - 0.5; };
  const ex = [];
  const t0 = Date.parse('2026-10-30T01:00:00Z');
  for (let i = 0; i < 1500; i++) { px += rand() * 20; ex.push(px); }
  for (let i = 0; i < 1500; i++) {
    f.append('ex', { t: t0 + i * 1000, coinbase: ex[i], kraken: ex[Math.max(0, i - 2)] });
    f.append('brti', { t: t0 + i * 1000, brti: ex[Math.max(0, i - 3)] });
  }
  const r = leadLag(f, t0, t0 + 1500 * 1000);
  const cb = r.sources.find((s) => s.key === 'coinbase'), kr = r.sources.find((s) => s.key === 'kraken');
  assert.strictEqual(cb.bestLag, 3); assert.strictEqual(kr.bestLag, 1);
  assert.ok(cb.bestR > 0.95);
});

ok('a session is saved and reloads', () => {
  const s = new Sessions(tmp);
  s.start({ bankroll: 10000, stake: 10, weights: { distZ: 0.4 } });
  const again = new Sessions(tmp);
  assert.ok(again.active); assert.strictEqual(again.current.bankroll, 10000);
  again.stop({ every: {} });
  assert.ok(!new Sessions(tmp).active);
  assert.strictEqual(new Sessions(tmp).past().length, 1);
});

console.log(`${n} session checks passed`);
