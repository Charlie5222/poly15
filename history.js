'use strict';
/**
 * history.js: past rounds from Polymarket US's own records, and a walk-forward
 * backtest over them.
 *
 * Per round we keep three things, all from the official US gateway:
 *   - the event:          exact price to beat and the result
 *   - price history:      the Yes and No ask, one point a minute
 *   - BRTI, 1 second:     the index the round settles on, for the last ~7 min
 *
 * TIMESTAMP TRAP. A price-history point labelled t holds the price at the END
 * of the minute starting at t (measured against our own live recordings:
 * matching at t+60s is about 3x closer than at t). Reading the point labelled
 * t as "the price at t" would let a backtest see 60 seconds into the future.
 * We relabel every point to the moment it describes before storing it.
 *
 * Polymarket keeps events for roughly four weeks, so the server tops this up
 * every hour. Records already on disk are kept for good.
 */

const fs = require('fs');
const path = require('path');
const us = require('./us');
const paper = require('./paper');

// Earliest rounds with price history on the US exchange.
const HIST_START = { 15: Date.UTC(2026, 9, 2), 5: Date.UTC(2026, 9, 23) };
const BRTI_LOOKBACK = 450;     // seconds of BRTI kept before each close
const BACKTEST_ENTRIES = [120, 60];   // minute points only; 30s needs live data
const MAX_RPS = Number(process.env.POLY15_BACKFILL_RPS || 4);   // the gateway starts refusing well below its documented 25/s

const fileFor = (dir, h) => path.join(dir, `rounds-${h}m.jsonl`);

function loadHistory(dir) {
  const out = new Map();
  for (const h of [15, 5]) {
    const f = fileFor(dir, h);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); out.set(r.slug, r); } catch { /* skip */ }
    }
  }
  return out;
}

/** A simple shared rate limiter: at most MAX_RPS requests per second. */
function limiter(rps) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + 1000 / rps;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
}

/**
 * Fetch every missing past round. Safe to interrupt: each round is appended
 * as soon as it is complete. onProgress({done, total, fetched}).
 */
async function backfill(dir, { horizons = [15, 5], until = Date.now(), onProgress, signal } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const have = loadHistory(dir);
  const wait = limiter(MAX_RPS);
  const todo = [];
  for (const h of horizons) {
    const step = h * 60000;
    // Events expire after ~4 weeks; don't ask for ones that can't exist.
    const from = Math.max(HIST_START[h], until - 29 * 86400000);
    for (let s = Math.ceil(from / step) * step; s + step <= until - 120000; s += step) {
      const slug = us.slugFor(new Date(s), h);
      const prev = have.get(slug);
      // Missing rounds get retried while they are young enough to appear.
      if (prev && !(prev.missing && until - s < 2 * 86400000)) continue;
      todo.push({ h, start: s, end: s + step, slug });
    }
  }
  const total = todo.length;
  let done = 0, fetched = 0;
  if (!total) { onProgress?.({ done, total, fetched }); return { total, fetched }; }

  // BRTI comes in hour-long chunks shared by every round inside them.
  const brtiChunks = new Map();
  const brtiHour = async (hourSec) => {
    if (!brtiChunks.has(hourSec)) {
      brtiChunks.set(hourSec, (async () => {
        await wait();
        try { return await us.fetchBrti(hourSec, hourSec + 3600, '1S'); } catch { return []; }
      })());
      if (brtiChunks.size > 6) brtiChunks.delete(brtiChunks.keys().next().value);
    }
    return brtiChunks.get(hourSec);
  };

  const one = async (job) => {
    const { h, start, end, slug } = job;
    let ev = null;
    try { await wait(); ev = await us.fetchEvent(slug); } catch { ev = null; }
    if (!ev || ev.priceToBeat == null) {
      fs.appendFileSync(fileFor(dir, h), JSON.stringify({ slug, h, start, end, missing: true }) + '\n');
      return;
    }
    let px = [], settledPx = null;
    try {
      await wait();
      const raw = await us.fetchPriceHistory('cpc-' + slug, start / 1000 - 120, end / 1000 + 120);
      // Relabel: the point stamped t is the price at t + 60s. Keep only
      // moments strictly before the close.
      px = raw.map((p) => [p.t + 60, p.yesAsk, p.noAsk]).filter((p) => p[0] < end / 1000);
      const fin = raw.filter((p) => p.t + 60 >= end / 1000 + 60).pop();
      if (fin && (fin.yesAsk === 1 || fin.yesAsk === 0)) settledPx = fin.yesAsk;
    } catch { px = []; }
    const endSec = end / 1000, from = endSec - BRTI_LOOKBACK;
    const pts = [];
    for (let hr = Math.floor(from / 3600) * 3600; hr < endSec; hr += 3600) {
      for (const c of await brtiHour(hr)) if (c.t >= from && c.t <= endSec) pts.push(c);
    }
    pts.sort((a, b) => a.t - b.t);
    // Store as cents relative to the first reading: small on disk.
    const base = pts.length ? Math.round(pts[0].v * 100) : 0;
    // The event's own result first; the settled price (1 or 0) as a fallback.
    let up = ev.resolvedUp;
    if (up == null && settledPx != null) up = settledPx;
    const rec = {
      slug, h, start, end, ptb: ev.priceToBeat, up, settle: ev.settlementPrice, coef: ev.feeCoefficient,
      px, brti: pts.length ? { t0: pts[0].t, base, d: pts.map((p) => [p.t - pts[0].t, Math.round(p.v * 100) - base]) } : null,
    };
    if (up == null) return;   // not settled yet; try again next time
    fs.appendFileSync(fileFor(dir, h), JSON.stringify(rec) + '\n');
    fetched++;
  };

  // A few workers; the limiter keeps the overall rate polite.
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      if (signal?.aborted) return;
      const job = todo[i++];
      try { await one(job); } catch { /* keep going */ }
      done++;
      if (done % 25 === 0 || done === total) onProgress?.({ done, total, fetched });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { total, fetched };
}

/** BRTI readings for one stored round as [{t, v}]. */
function brtiPoints(rec) {
  if (!rec.brti) return [];
  const { t0, base, d } = rec.brti;
  return d.map(([dt, dv]) => ({ t: t0 + dt, v: (base + dv) / 100 }));
}

/** The snapshot a live recorder would have seen `entry` seconds before close. */
function snapshotAt(rec, entry, points = brtiPoints(rec)) {
  const T = rec.end / 1000 - entry;
  // Latest quote known at T (already relabelled to the moment it describes).
  let q = null;
  for (const p of rec.px) if (p[0] <= T) q = p;
  if (!q || T - q[0] > 30 || q[1] == null || q[2] == null) return null;
  const ctx = paper.spotContext(points, T);
  if (ctx.spot == null) return null;
  return {
    snap: {
      horizon: rec.h, slug: rec.slug, ts: new Date(T * 1000).toISOString(), secsToClose: entry,
      priceToBeat: rec.ptb, spot: ctx.spot, momentum: ctx.momentum,
      yesQuote: q[1], noQuote: q[2], feeCoefficient: rec.coef ?? 0.0695,
    },
    vol: ctx.vol, T,
  };
}

/**
 * Walk-forward backtest. Rounds are replayed in time order; the model only
 * ever sees rounds that closed before the one it is predicting. Bets fill at
 * the quoted ask (the historical order book is not available), so results
 * are slightly optimistic for big stakes.
 */
function backtest(hist, { stake = 10 } = {}) {
  const recs = [...hist.values()].filter((r) => !r.missing && r.up != null && r.px?.length)
    .sort((a, b) => a.end - b.end);
  const model = new paper.Model(null);
  const scored = [];
  const rows = [];           // for warm-starting the live model
  const queue = [];          // rows waiting for their round to close
  let lastFit = 0;
  for (const rec of recs) {
    const pts = brtiPoints(rec);
    // Train on everything that has closed by now.
    while (queue.length && queue[0].end <= rec.end - rec.h * 60000) {
      const r = queue.shift();
      model.add(r.key, r.f, r.mkt, r.y, { src: 'history', refit: false });
    }
    if (model.trained - lastFit >= 50 || (model.trained > 0 && lastFit === 0)) { model.fit(); lastFit = model.trained; }

    for (const entry of BACKTEST_ENTRIES) {
      const s = snapshotAt(rec, entry, pts);
      if (!s) continue;
      const made = paper.makePredictions(s.snap, s.vol, model, stake);
      for (const p of made.predictions) {
        const sc = paper.score(p, rec.up);
        scored.push({
          slug: rec.slug, horizon: rec.h, entry, strategy: p.strategy, side: p.side, price: p.price, fee: p.fee,
          stake: p.stake, won: sc.won, pnl: sc.pnl, modelProb: p.modelProb ?? null,
        });
      }
      // Maker orders: filled only if a later minute point, still before the
      // close, traded through our bid.
      for (const o of paper.makerOrders(s.snap, made.marketProb, made.modelProb, stake)) {
        const later = rec.px.filter((p) => p[0] > s.T && p[0] < rec.end / 1000);
        const filled = later.some((p) => paper.makerFillsAt(o, { yesQuote: p[1], noQuote: p[2] }));
        const row = { slug: rec.slug, horizon: rec.h, entry, strategy: o.strategy, side: o.side, price: o.bid, fee: 0, stake: o.stake, filled };
        if (filled) Object.assign(row, paper.score(o, rec.up));
        else Object.assign(row, { won: false, pnl: 0 });
        scored.push(row);
      }
      if (entry === 60) model.recordOutOfSample(`${rec.slug}@${entry}`, made.modelProb, made.marketProb, rec.up);
      const row = { key: `${rec.slug}@${entry}`, f: made.features, mkt: made.marketProb, y: rec.up, end: rec.end };
      queue.push(row);
      rows.push(row);
    }
  }
  model.fit();

  const slice = (fn) => paper.summarize(scored.filter(fn));
  const breakdown = {};
  for (const e of ['all', ...BACKTEST_ENTRIES]) {
    for (const h of ['all', 15, 5]) {
      breakdown[`${e}|${h}`] = slice((r) => (e === 'all' || r.entry === e) && (h === 'all' || r.horizon === h));
    }
  }
  const md = scored.filter((r) => r.strategy === 'model_direction' && r.entry === 60);
  return {
    builtAt: new Date().toISOString(),
    rounds: recs.length,
    byHorizon: { 15: recs.filter((r) => r.h === 15).length, 5: recs.filter((r) => r.h === 5).length },
    from: recs[0] ? new Date(recs[0].start).toISOString() : null,
    to: recs.length ? new Date(recs[recs.length - 1].end).toISOString() : null,
    entries: BACKTEST_ENTRIES,
    breakdown,
    gate1: model.benchmark(),
    gate2: paper.calibrationGate(md),
    weights: paper.FEATURE_KEYS.map((k) => ({ key: k, w: model.w[k] })),
    rows,
  };
}

module.exports = { loadHistory, backfill, backtest, snapshotAt, brtiPoints, HIST_START, BACKTEST_ENTRIES };
