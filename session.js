'use strict';
/**
 * session.js: a test run with a pretend bankroll, and the report on it.
 *
 * A session is a time window. Every bet the app places inside it counts,
 * and the report is rebuilt from the recorded bets, so nothing is lost if
 * the app restarts mid-session.
 */

const fs = require('fs');
const path = require('path');
const paper = require('./paper');

const keyOf = (slug, entry) => `${slug}@${entry}`;
const MIN_SLICE = 15;            // bets a slice needs before it is called a pattern

class Sessions {
  constructor(dir) {
    this.file = path.join(dir, 'session.json');
    this.dir = path.join(dir, 'sessions');
    this.current = null;
    try { this.current = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
  }
  get active() { return !!(this.current && !this.current.endedAt); }
  start({ bankroll, stake, weights }) {
    this.current = {
      id: new Date().toISOString().replace(/[:.]/g, '-'), startedAt: new Date().toISOString(), endedAt: null,
      bankroll, stake, weightsAtStart: weights,
    };
    this.save();
    return this.current;
  }
  stop(report) {
    if (!this.active) return null;
    this.current.endedAt = new Date().toISOString();
    this.save();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${this.current.id}.json`), JSON.stringify({ session: this.current, report }, null, 2));
    } catch {}
    return this.current;
  }
  save() { try { fs.writeFileSync(this.file, JSON.stringify(this.current, null, 2)); } catch {} }
  past() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 10)
        .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')).session);
    } catch { return []; }
  }
}

/** Win rate, break-even, profit and a luck check for one group of $-bets. */
function tally(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  const wins = rows.filter((r) => r.won).length;
  const pnl = rows.reduce((a, r) => a + r.pnl, 0);
  const staked = rows.reduce((a, r) => a + (r.stake || 0), 0);
  const need = rows.reduce((a, r) => a + r.price + (r.fee || 0), 0) / n;
  const mean = pnl / n;
  const sd = Math.sqrt(rows.reduce((a, r) => a + (r.pnl - mean) ** 2, 0) / Math.max(1, n - 1));
  // How many standard errors the profit sits from zero. Above 2 is unlikely
  // to be luck for one slice; with many slices some will reach 2 by chance.
  const z = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  return { n, wins, winRate: wins / n, need, pnl, staked, roi: staked ? pnl / staked : 0, z };
}

/** Bankroll after each bet in time order, with the worst drop from a peak. */
function curve(rows, start) {
  const sorted = [...rows].sort((a, b) => (a.endMs - b.endMs) || a.ts.localeCompare(b.ts));
  let bank = start, peak = start, maxDd = 0, streak = 0, bestW = 0, worstL = 0;
  const pts = [{ t: null, v: start }];
  for (const r of sorted) {
    bank += r.pnl;
    peak = Math.max(peak, bank);
    maxDd = Math.max(maxDd, peak - bank);
    streak = r.won ? Math.max(1, streak + 1) : Math.min(-1, streak - 1);
    bestW = Math.max(bestW, streak); worstL = Math.min(worstL, streak);
    pts.push({ t: r.endMs, v: Math.round(bank * 100) / 100 });
  }
  // Keep the chart light: at most ~300 points.
  const step = Math.max(1, Math.ceil(pts.length / 300));
  const thin = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  return { end: bank, peak, maxDrawdown: maxDd, longestWin: bestW, longestLoss: -worstL, points: thin };
}

const band = (p) => p < 0.6 ? 'under 60¢' : p < 0.8 ? '60–80¢' : p < 0.9 ? '80–90¢' : p < 0.95 ? '90–95¢' : '95¢ and up';
const BAND_ORDER = ['under 60¢', '60–80¢', '80–90¢', '90–95¢', '95¢ and up'];

/**
 * Slice the call's bets every way that might matter and say which slices
 * beat their own break-even. These are the "patterns" to look into.
 */
function patterns(callRows, tz) {
  const hourOf = (ms) => Number(new Date(ms).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz })) % 24;
  const volMed = median(callRows.map((r) => r.vol).filter((v) => v != null));
  const distMed = median(callRows.map((r) => r.absDist).filter((v) => v != null));
  const groups = [
    { id: 'entry', title: 'When the bet goes on', key: (r) => `${r.entry === 120 ? '2 min' : r.entry === 60 ? '1 min' : '30 s'} left`, order: ['2 min left', '1 min left', '30 s left'] },
    { id: 'horizon', title: 'Round length', key: (r) => `${r.horizon}-minute rounds` },
    { id: 'side', title: 'Which side', key: (r) => `BUY ${r.side}` },
    { id: 'price', title: 'Price paid (fee included)', key: (r) => band(r.price + (r.fee || 0)), order: BAND_ORDER },
    { id: 'verdict', title: 'Price verdict', key: (r) => r.verdict === 'good' ? 'Marked Good price' : r.verdict === 'learning' ? 'Learning' : 'Marked Too expensive' },
    { id: 'agree', title: 'Model vs market', key: (r) => r.agrees == null ? null : r.agrees ? 'Model agrees with the market' : 'Model picks the underdog' },
    { id: 'vol', title: 'How jumpy BTC was', key: (r) => r.vol == null || volMed == null ? null : r.vol >= volMed ? 'Jumpier than usual' : 'Calmer than usual' },
    { id: 'dist', title: 'BTC distance from the line', key: (r) => r.absDist == null || distMed == null ? null : r.absDist >= distMed ? 'Far from the line' : 'Close to the line' },
    { id: 'flip', title: 'Did the call change during the round', key: (r) => r.flipped == null ? null : r.flipped ? 'Call flipped sides' : 'Call held steady' },
    { id: 'hour', title: 'Time of night', key: (r) => { const h = hourOf(r.endMs); const b = Math.floor(h / 3) * 3; return `${fmtHour(b)}–${fmtHour((b + 3) % 24)}`; } },
  ];
  const out = [];
  for (const g of groups) {
    const by = new Map();
    for (const r of callRows) {
      const k = g.key(r);
      if (k == null) continue;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r);
    }
    let rows = [...by.entries()].map(([label, list]) => ({ label, ...tally(list) }));
    if (g.order) rows.sort((a, b) => g.order.indexOf(a.label) - g.order.indexOf(b.label));
    else rows.sort((a, b) => a.label.localeCompare(b.label));
    if (rows.length) out.push({ id: g.id, title: g.title, rows });
  }
  return out;
}
const fmtHour = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Plain-language findings: slices that beat break-even, and ones that clearly lose. */
function findings(groups, every) {
  const out = [];
  // Whether the call flipped is only known once the round is over, so it
  // describes what happened rather than something to bet on.
  const all = groups.filter((g) => g.id !== 'flip').flatMap((g) => g.rows.map((r) => ({ ...r, group: g.title })));
  const good = all.filter((r) => r.n >= MIN_SLICE && r.pnl > 0).sort((a, b) => b.z - a.z);
  const bad = all.filter((r) => r.n >= MIN_SLICE && r.pnl < 0).sort((a, b) => a.z - b.z);
  for (const r of good.slice(0, 4)) {
    out.push({
      kind: r.z >= 2 ? 'promising' : 'hint', group: r.group, label: r.label, n: r.n, pnl: r.pnl, z: r.z,
      text: `${r.label}: won ${(r.winRate * 100).toFixed(0)}% when it needed ${(r.need * 100).toFixed(0)}%, ${r.pnl >= 0 ? '+' : '−'}$${Math.abs(r.pnl).toFixed(0)} over ${r.n} bets.`
        + (r.z >= 2 ? ' Strong enough to look into.' : ' Could still be luck.'),
    });
  }
  for (const r of bad.slice(0, 2)) {
    out.push({
      kind: 'avoid', group: r.group, label: r.label, n: r.n, pnl: r.pnl, z: r.z,
      text: `${r.label}: won ${(r.winRate * 100).toFixed(0)}% but needed ${(r.need * 100).toFixed(0)}%, −$${Math.abs(r.pnl).toFixed(0)} over ${r.n} bets.`,
    });
  }
  if (every && every.n && every.n < 100) out.push({ kind: 'note', text: `Only ${every.n} bets so far. Under about 300, most differences are luck.` });
  return out;
}

/**
 * What would have happened had we sold when the call flipped, instead of
 * holding to the end. Uses the order book recorded at the later check.
 */
function sellOnFlip(recsBySlug, statusOf) {
  let n = 0, holdPnl = 0, sellPnl = 0;
  for (const recs of recsBySlug.values()) {
    const seq = recs.filter((r) => r.call).sort((a, b) => b.entry - a.entry);
    for (let i = 0; i < seq.length; i++) {
      const a = seq[i], c = a.call;
      const later = seq.slice(i + 1).find((b) => b.call.side !== c.side && b.book?.bids?.length && b.book?.offers?.length);
      if (!later || a.resolvedUp == null) continue;
      const bid = c.side === 'UP' ? later.book.bids[0].px : 1 - later.book.offers[0].px;
      if (!(bid > 0)) continue;
      const shares = c.stake / c.need;
      const fee = shares * paper.takerFeePerShare(bid, 0.0695);
      const won = (c.side === 'UP') === (a.resolvedUp === 1);
      n++;
      holdPnl += (won ? shares : 0) - c.stake;
      sellPnl += shares * bid - fee - c.stake;
    }
  }
  return { n, holdPnl, sellPnl, better: sellPnl - holdPnl };
}

/**
 * Build the whole report.
 *  scored: store.scored rows; preds: Map key -> prediction record.
 */
function report(sess, { scored, preds, rounds, statusOf, model, tz = 'America/Los_Angeles', parseSlug }) {
  if (!sess) return null;
  const t0 = Date.parse(sess.startedAt), t1 = sess.endedAt ? Date.parse(sess.endedAt) : Infinity;
  const inSess = (ts) => { const t = Date.parse(ts); return t >= t0 && t <= t1; };
  const stake = sess.stake;
  // Re-express every bet at the session stake, so a stake change mid-way
  // cannot skew the totals.
  const scale = (r) => {
    const k = r.stake ? stake / r.stake : 1;
    return { ...r, stake, shares: (r.shares || 0) * k, pnl: r.pnl * k };
  };

  const rows = scored.filter((r) => r.modelVersion === 2 && inSess(r.ts)).map(scale);
  const byKey = new Map();
  for (const r of rows) {
    const k = keyOf(r.slug, r.entry);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }

  // The BUY call's own bet each time a bet went on, with what we knew then.
  const callRows = [], goodRows = [];
  const recsBySlug = new Map();
  for (const rec of preds.values()) {
    if (rec.modelVersion !== 2 || !inSess(rec.ts)) continue;
    const c = paper.callFrom(rec.predictions || [], statusOf(rec));
    if (!recsBySlug.has(rec.slug)) recsBySlug.set(rec.slug, []);
    const resolvedUp = rounds.get(rec.slug)?.resolvedUp ?? null;
    recsBySlug.get(rec.slug).push({ entry: rec.entry, call: c ? { ...c, stake, need: c.need } : null, book: rec.book, resolvedUp });
  }
  for (const [slug, recs] of recsBySlug) {
    const sides = new Set(recs.filter((r) => r.call).map((r) => r.call.side));
    for (const r of recs) r.flipped = sides.size > 1;
  }
  for (const [k, list] of byKey) {
    const rec = preds.get(k);
    const c = rec && paper.callFrom(rec.predictions || [], statusOf(rec));
    if (!c) continue;
    const mine = list.find((b) => b.strategy === c.strategy);
    if (!mine) continue;
    const mkt = rec.marketProb;
    const favUp = mkt != null ? mkt >= 0.5 : null;
    const flipped = recsBySlug.get(rec.slug)?.[0]?.flipped ?? null;
    const row = {
      ...mine, strategy: 'call', verdict: c.verdict, endMs: parseSlug(rec.slug)?.endMs ?? Date.parse(rec.ts),
      vol: rec.vol ?? null, absDist: rec.features ? Math.abs(rec.features.distZ) : null,
      agrees: favUp == null ? null : (c.side === 'UP') === favUp, flipped,
    };
    callRows.push(row);
    if (c.verdict === 'good') goodRows.push({ ...row, strategy: 'call_good' });
  }

  const every = tally(callRows), good = tally(goodRows);
  const strategies = paper.summarize(rows.filter((r) => r.filled !== false))
    .map((s) => ({ strategy: s.strategy, n: s.n, winRate: s.winRate, breakeven: s.breakeven, pnl: s.pnl, roi: s.roi }));
  const groups = patterns(callRows, tz);
  const ridingNow = [...preds.values()].filter((p) => p.modelVersion === 2 && inSess(p.ts) && !byKey.has(keyOf(p.slug, p.entry))).length;

  // What the model changed its mind about since the session started.
  const w0 = sess.weightsAtStart || {};
  const weights = paper.FEATURE_KEYS.map((k) => ({ key: k, label: paper.LABEL[k], start: w0[k] ?? null, now: model.w[k] || 0 }));

  const endedAt = sess.endedAt || new Date().toISOString();
  return {
    session: sess, endedAt, hours: (Date.parse(endedAt) - t0) / 3600000,
    rounds: new Set(callRows.map((r) => r.slug)).size,
    roundsWatched: [...rounds.keys()].filter((slug) => { const e = parseSlug(slug)?.endMs; return e >= t0 && e <= Math.min(t1, Date.now()); }).length,
    pending: ridingNow,
    every: { ...every, ...curve(callRows, sess.bankroll) },
    good: { ...good, ...curve(goodRows, sess.bankroll) },
    strategies, patterns: groups, findings: findings(groups, every),
    sellOnFlip: sellOnFlip(recsBySlug, statusOf),
    weights,
  };
}

module.exports = { Sessions, report, tally, curve, patterns, findings, sellOnFlip, band };
