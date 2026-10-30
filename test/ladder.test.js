'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Ladder, record, report, gapReport, gapBet } = require('../ladder');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-'));
// due(): only inside the 20s after each whole minute, never the 15th minute.
assert.deepStrictEqual(Ladder.due(15, 600), [10]);
assert.deepStrictEqual(Ladder.due(15, 585), [10]);
assert.deepStrictEqual(Ladder.due(15, 579), []);
assert.deepStrictEqual(Ladder.due(15, 900), []);
assert.deepStrictEqual(Ladder.due(5, 60), [1]);
assert.deepStrictEqual(Ladder.due(5, 25), [0.5]);

const L = new Ladder(dir);
const t = '2026-10-30T06:00:00Z';
const mk = (slug, min, side, price, verdict) => record({ slug, horizon: 15, min, ts: t, secsToClose: min * 60,
  call: { side, price, fee: 0, verdict }, fav: { side, price, fee: 0 }, modelProb: 0.7, marketProb: 0.7 });
assert.ok(L.add(mk('a', 3, 'UP', 0.5, 'good')));
assert.ok(!L.add(mk('a', 3, 'UP', 0.5, 'good')), 'no duplicates');
L.add(mk('b', 3, 'UP', 0.5, 'pricey'));
L.add(mk('c', 2, 'DOWN', 0.8, 'pricey'));
const rounds = new Map([['a', { resolvedUp: 1 }], ['b', { resolvedUp: 0 }]]);
const rep = report(L, { from: Date.parse(t) - 1, to: Date.parse(t) + 1, rounds, stake: 10 });
assert.strictEqual(rep.waiting, 1);
const row = rep.rows.find((r) => r.min === 3);
assert.strictEqual(row.call.n, 2); assert.strictEqual(row.call.wins, 1);
assert.ok(Math.abs(row.call.pnl - 0) < 1e-9, 'one $10 win at 50c (+10) and one loss (-10)');
assert.strictEqual(row.good.n, 1);
// Persists across restarts.
assert.strictEqual(new Ladder(dir).recs.length, 3);
// The gap rule: $20+ away, follows the gap, skips dear prices, counts rounds.
const G = new Ladder(fs.mkdtempSync(path.join(os.tmpdir(), 'gap-')));
const gr = (slug, min, value, up = 0.6, down = 0.5) => G.add(record({ slug, horizon: 5, min, ts: t, secsToClose: min * 60, gap: { value, up: { price: up, fee: 0 }, down: { price: down, fee: 0 } } }));
assert.strictEqual(gapBet(record({ slug: 'x', horizon: 5, min: 1, gap: { value: 19, up: { price: 0.5, fee: 0 } } })), null, 'under $20: no bet');
assert.strictEqual(gapBet(record({ slug: 'x', horizon: 5, min: 1, gap: { value: 25, up: { price: 0.98, fee: 0 } } })), null, 'too dear: no bet');
assert.strictEqual(gapBet(record({ slug: 'x', horizon: 5, min: 1, gap: { value: -25, down: { price: 0.5, fee: 0 } } })).side, 'DOWN');
gr('a', 2, 30); gr('a', 0.5, 30); gr('b', 1, -30); gr('c', 1, 5); gr('d', 1, 40);
const g = gapReport(G, { from: Date.parse(t) - 1, to: Date.parse(t) + 1, rounds: new Map([['a', { resolvedUp: 1 }], ['b', { resolvedUp: 1 }], ['c', { resolvedUp: 1 }]]), stake: 10 });
assert.strictEqual(g.all.n, 3); assert.strictEqual(g.all.rounds, 2); assert.strictEqual(g.all.wins, 2); assert.strictEqual(g.waiting, 1);
assert.strictEqual(g.watched, 5);
assert.strictEqual(report(G, { from: Date.parse(t) - 1, to: Date.parse(t) + 1, rounds: new Map([['a', { resolvedUp: 1 }]]), stake: 10 }).rows.every((r) => r.min >= 1), true, '30s mark stays out of the every-minute table');
console.log('ladder: 9 checks passed');
