'use strict';
/**
 * ladder.js: the every-minute test. During a session, at each whole minute
 * left in a round (14m, 13m ... 1m on 15m rounds; 4m ... 1m on 5m rounds) it
 * writes down the BUY call and the market's favourite as pretend bets.
 *
 * Separate from the real bets on purpose: these never count in the session
 * totals and the model never learns from them, so the main test stays clean.
 * The question it answers: is there a time left where the call wins more
 * often than its price needs?
 */

const fs = require('fs');
const path = require('path');

const WINDOW = 20;               // seconds after a minute mark in which it may still be written down

// The exchange-gap test. Fixed before the first night it ran, so the rule
// cannot be fitted to its own results: follow the exchanges when they sit at
// least this far from BRTI, and skip prices too high to be worth it.
const GAP_RULE = { minGap: 20, maxPrice: 0.97 };

class Ladder {
  constructor(dir) {
    this.file = path.join(dir, 'ladder.jsonl');
    this.recs = [];
    this.seen = new Set();
    try {
      for (const l of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!l) continue;
        try { const r = JSON.parse(l); this.recs.push(r); this.seen.add(`${r.slug}@${r.min}`); } catch {}
      }
    } catch {}
  }
  /** The minute marks due right now for a round with `secsToClose` left. */
  static due(horizon, secsToClose) {
    const out = [];
    for (let m = horizon - 1; m >= 1; m--) {
      if (secsToClose <= m * 60 && secsToClose > m * 60 - WINDOW) out.push(m);
    }
    if (secsToClose <= 30 && secsToClose > 10) out.push(0.5);   // the 30s bet time, for the gap test
    return out;
  }
  has(slug, min) { return this.seen.has(`${slug}@${min}`); }
  add(rec) {
    if (this.has(rec.slug, rec.min)) return false;
    this.recs.push(rec); this.seen.add(`${rec.slug}@${rec.min}`);
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch {}
    return true;
  }
}

/** Build a record from a call and the follow-the-market bet. */
function record({ slug, horizon, min, ts, secsToClose, call, fav, modelProb, marketProb, gap }) {
  const bet = (b) => (b ? { side: b.side, price: b.price, fee: b.fee || 0 } : null);
  return {
    slug, h: horizon, min, ts, secsToClose, modelProb, marketProb,
    call: call ? { ...bet(call), verdict: call.verdict } : null,
    fav: bet(fav), gap: gap || null,
  };
}

/** The bet the gap rule makes on this record, if any. */
function gapBet(rec) {
  const g = rec.gap;
  if (!g || Math.abs(g.value) < GAP_RULE.minGap) return null;
  const side = g.value > 0 ? 'UP' : 'DOWN';
  const b = side === 'UP' ? g.up : g.down;
  if (!b || b.price > GAP_RULE.maxPrice) return null;
  return { side, price: b.price, fee: b.fee };
}

function score(bet, resolvedUp, stake) {
  const won = (resolvedUp === 1) === (bet.side === 'UP');
  const cost = bet.price + bet.fee;
  return { won, need: cost, pnl: won ? stake / cost - stake : -stake };
}

function sum(list) {
  const n = list.length;
  if (!n) return { n: 0 };
  const wins = list.filter((x) => x.won).length;
  const pnl = list.reduce((a, x) => a + x.pnl, 0);
  const mean = pnl / n;
  const sd = Math.sqrt(list.reduce((a, x) => a + (x.pnl - mean) ** 2, 0) / Math.max(1, n - 1));
  return {
    n, wins, winRate: wins / n, need: list.reduce((a, x) => a + x.need, 0) / n, pnl,
    z: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
  };
}

/**
 * One row per horizon and minute: the BUY call, the call when the price was
 * good, and simply buying the market's favourite.
 */
function report(ladder, { from, to, rounds, stake }) {
  const groups = new Map();
  let waiting = 0;
  for (const r of ladder.recs) {
    const t = Date.parse(r.ts);
    if (t < from || t > to || r.min < 1) continue;
    const up = rounds.get(r.slug)?.resolvedUp;
    if (up == null) { waiting++; continue; }
    const k = `${r.h}|${r.min}`;
    if (!groups.has(k)) groups.set(k, { h: r.h, min: r.min, call: [], good: [], fav: [] });
    const g = groups.get(k);
    if (r.call) {
      const s = score(r.call, up, stake);
      g.call.push(s);
      if (r.call.verdict === 'good') g.good.push(s);
    }
    if (r.fav) g.fav.push(score(r.fav, up, stake));
  }
  const rows = [...groups.values()]
    .sort((a, b) => b.h - a.h || b.min - a.min)
    .map((g) => ({ h: g.h, min: g.min, call: sum(g.call), good: sum(g.good), fav: sum(g.fav) }));
  // With ~18 minutes tested, one usually looks good by luck: flag only a
  // strong one, and say how many were checked.
  const best = rows.filter((r) => r.call.n >= 15).sort((a, b) => b.call.z - a.call.z)[0] || null;
  return { rows, waiting, tested: rows.length, best: best && best.call.pnl > 0 ? { h: best.h, min: best.min, ...best.call, strong: best.call.z >= 3 } : null };
}

/**
 * The gap rule's results. Bets inside one round move together, so the luck
 * check (z) counts rounds, not bets. `all` is the headline; judged once enough
 * nights are in, by the fixed test: z of 2 or more with a profit.
 */
function gapReport(ladder, { from, to, rounds, stake }) {
  const bets = [];
  let watched = 0, waiting = 0;
  for (const r of ladder.recs) {
    const t = Date.parse(r.ts);
    if (t < from || t > to || !r.gap) continue;
    watched++;
    const bet = gapBet(r);
    if (!bet) continue;
    const up = rounds.get(r.slug)?.resolvedUp;
    if (up == null) { waiting++; continue; }
    bets.push({ ...r, ...score(bet, up, stake) });
  }
  const group = (list) => {
    const s = sum(list);
    const byRound = new Map();
    for (const b of list) byRound.set(b.slug, (byRound.get(b.slug) || 0) + b.pnl);
    const v = [...byRound.values()], m = v.reduce((a, x) => a + x, 0) / (v.length || 1);
    const sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, v.length - 1));
    return { ...s, rounds: v.length, z: sd > 0 ? m / (sd / Math.sqrt(v.length)) : 0 };
  };
  const all = group(bets);
  return {
    rule: GAP_RULE, watched, waiting, all,
    betTimes: group(bets.filter((b) => [2, 1, 0.5].includes(b.min))),
    five: group(bets.filter((b) => b.h === 5)),
    fifteen: group(bets.filter((b) => b.h === 15)),
    promising: all.n > 0 && all.pnl > 0 && all.z >= 2,
  };
}

module.exports = { Ladder, record, report, gapReport, gapBet, score, GAP_RULE, WINDOW };
