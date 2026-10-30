'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Ladder, record, report } = require('../ladder');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-'));
// due(): only inside the 20s after each whole minute, never the 15th minute.
assert.deepStrictEqual(Ladder.due(15, 600), [10]);
assert.deepStrictEqual(Ladder.due(15, 585), [10]);
assert.deepStrictEqual(Ladder.due(15, 579), []);
assert.deepStrictEqual(Ladder.due(15, 900), []);
assert.deepStrictEqual(Ladder.due(5, 60), [1]);

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
console.log('ladder: 5 checks passed');
