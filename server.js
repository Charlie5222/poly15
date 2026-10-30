'use strict';
/**
 * server.js: poly15. Records Polymarket US BTC up/down rounds, paper trades
 * them, and serves the UI.
 *
 * Read-only against the market: public data, no key, no wallet, no orders.
 * Binds to 127.0.0.1 only, and refuses requests that did not come from its
 * own page (see `allowed`).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const us = require('./us');
const paper = require('./paper');
const history = require('./history');
const { Store, keyOf, PRIMARY_ENTRY } = require('./store');

const DATA = process.env.POLY15_DATA || path.join(__dirname, 'data');
const HIST_DIR = path.join(DATA, 'history');
const MODEL = path.join(DATA, 'model.json');
const SETTINGS = path.join(DATA, 'settings.json');
const BACKTEST = path.join(DATA, 'backtest.json');
const PORT = Number(process.env.PORT || 18790);
const POLL_MS = Number(process.env.POLL_MS || 10000);
const ENTRY_WINDOW = 20;          // seconds after an entry time in which a bet may still be placed
const ALL_ENTRIES = [120, 60, 30];
const BACKFILL_EVERY = 60 * 60000;
const NO_BACKFILL = process.env.POLY15_NO_BACKFILL === '1';

const store = new Store(DATA);

const DEFAULTS = { recording: true, horizons: [15, 5], entries: [120, 60, 30], stake: 10, stopAfter: 0, stopBaseline: 0 };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) }; } catch {}
delete settings.entrySecs;        // v1 setting, replaced by `entries`
const saveSettings = () => { try { fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); } catch {} };

const state = {
  startedAt: new Date().toISOString(), polls: 0, lastError: null, last: {}, log: [], stoppedReason: null,
  backfill: { running: false, done: 0, total: 0, lastRun: null, error: null },
};
const note = (m) => { state.log.push({ ts: new Date().toISOString(), m }); if (state.log.length > 300) state.log.shift(); };

const model = new paper.Model(MODEL);
let backtestResult = null;
try { backtestResult = JSON.parse(fs.readFileSync(BACKTEST, 'utf8')); } catch {}
if (backtestResult) { state.backfill.rounds = backtestResult.rounds; state.backfill.lastRun = backtestResult.builtAt; }

// ---------------- BTC: the BRTI index the rounds settle on ----------------

const brti = [];                  // [{ t (unix s), v }], last ~15 minutes, 1 per second
async function refreshBrti() {
  const now = Math.floor(Date.now() / 1000);
  const from = brti.length ? Math.max(brti[brti.length - 1].t + 1, now - 900) : now - 900;
  if (from > now - 1) return;
  try {
    const pts = await us.fetchBrti(from, 0, '1S');
    for (const p of pts) if (!brti.length || p.t > brti[brti.length - 1].t) brti.push({ t: p.t, v: p.v });
    while (brti.length && brti[0].t < now - 900) brti.shift();
  } catch (e) { note(`BRTI: ${e.message}`); }
}
const spotNow = () => paper.spotContext(brti, Math.floor(Date.now() / 1000));

let chartCache = { rows: [], at: 0 };
async function chartCandles() {
  if (Date.now() - chartCache.at < 30000 && chartCache.rows.length) return chartCache.rows;
  try {
    const now = Math.floor(Date.now() / 1000);
    const c = await us.fetchBrti(now - 120 * 60, 0, '1M');
    if (c.length) chartCache = { rows: c.map((x) => ({ t: x.t * 1000, open: x.o, high: x.h, low: x.l, close: x.v })), at: Date.now() };
  } catch { chartCache.at = Date.now(); }
  return chartCache.rows;
}

// ---------------- recording and betting ----------------

let scoredRoundsCache = { v: -1, n: 0 };
const scoredRounds = () => {
  if (scoredRoundsCache.v !== store.version) scoredRoundsCache = { v: store.version, n: store.scoredRounds() };
  return scoredRoundsCache.n;
};
/** The limit counts rounds scored since it was set, not since the app was born. */
const stopHit = () => settings.stopAfter > 0 && scoredRounds() - (settings.stopBaseline || 0) >= settings.stopAfter;

async function pollHorizon(mins) {
  const now = new Date();
  const r = await us.fetchRound(now, mins);
  if (!r) { note(`${mins}m: round not listed yet`); return; }

  const endMs = r.windowEnd ? Date.parse(r.windowEnd) : null;
  const secsToClose = endMs ? Math.round((endMs - now.getTime()) / 1000) : null;

  // The event's quotes are cached and can trail the live book by several
  // cents. Read the book itself while the round is open and price off that.
  let book = null;
  if (r.status === 'MARKET_STATUS_OPEN' && r.marketSlug) {
    try { book = await us.fetchBook(r.marketSlug); } catch { book = null; }
  }
  r.eventYesQuote = r.yesQuote; r.eventNoQuote = r.noQuote; r.quoteSrc = 'event';
  if (book?.offers.length && book?.bids.length) {
    r.yesQuote = book.offers[0].px;
    r.noQuote = Math.round((1 - book.bids[0].px) * 1e6) / 1e6;
    r.quoteSrc = 'book';
  }
  const ctx = spotNow();
  const snap = {
    ts: now.toISOString(), secsToClose, spot: ctx.spot, momentum: ctx.momentum, vol: ctx.vol, ...r,
  };
  store.addSnapshot({
    ts: snap.ts, slug: r.slug, horizon: mins, secsToClose, status: r.status, priceToBeat: r.priceToBeat,
    spot: ctx.spot, spotAt: ctx.spotAt, vol: ctx.vol, momentum: ctx.momentum,
    yesQuote: r.yesQuote, noQuote: r.noQuote, quoteSrc: r.quoteSrc, eventYesQuote: r.eventYesQuote, eventNoQuote: r.eventNoQuote,
    depth: book ? { bids: book.bids.slice(0, 3), offers: book.offers.slice(0, 3) } : null,
  });
  const mkt = paper.marketProb(snap);
  let call = null;
  if (ctx.spot != null && r.status === 'MARKET_STATUS_OPEN') {
    call = paper.callFrom(paper.makePredictions(snap, ctx.vol, model, settings.stake, { book }).predictions,
      { trained: model.trained, informative: model.isInformative() });
  }
  state.last[mins] = { ...snap, marketProb: mkt, modelProb: ctx.spot != null ? model.prob(paper.features(snap, ctx.vol), mkt) : null, call };
  state.polls++;

  // Resting maker orders on this round: did this quote trade through them?
  if (r.status === 'MARKET_STATUS_OPEN' && secsToClose > 0) {
    for (const e of ALL_ENTRIES) {
      const rec = store.preds.get(keyOf(r.slug, e));
      for (const o of rec?.maker || []) {
        if (!o.filled && Date.parse(rec.ts) < now.getTime() && paper.makerFillsAt(o, snap)) {
          store.markMakerFill(rec, o, snap.ts);
          note(`maker fill: ${o.strategy} on ${r.slug}`);
        }
      }
    }
  }

  if (!settings.recording || stopHit() || r.status !== 'MARKET_STATUS_OPEN' || secsToClose == null) return;
  for (const entry of settings.entries) {
    const due = secsToClose <= entry && secsToClose > entry - ENTRY_WINDOW && secsToClose > 5;
    if (!due || store.hasPrediction(r.slug, entry)) continue;
    if (ctx.spot == null) { note(`${r.slug}@${entry}: no BTC reading, skipped`); continue; }
    const made = paper.makePredictions(snap, ctx.vol, model, settings.stake, { book });
    const maker = entry === PRIMARY_ENTRY ? paper.makerOrders(snap, made.marketProb, made.modelProb, settings.stake) : [];
    store.addPrediction({
      slug: r.slug, horizon: mins, entry, ts: now.toISOString(), secsToClose, modelVersion: 2,
      spot: ctx.spot, spotAt: ctx.spotAt, vol: ctx.vol, priceToBeat: r.priceToBeat,
      yesQuote: r.yesQuote, noQuote: r.noQuote, quoteSrc: r.quoteSrc,
      features: made.features, marketProb: made.marketProb, modelProb: made.modelProb,
      modelTrained: model.trained, informative: model.isInformative(),
      stake: settings.stake,
      book: book ? { bids: book.bids.slice(0, 5), offers: book.offers.slice(0, 5) } : null,
      predictions: made.predictions, maker,
    });
    note(`bets placed on ${r.slug} at ${entry}s`);
  }
}

function settle(rec, resolvedUp) {
  if (store.isScored(rec)) return;
  const y = resolvedUp === 1 ? 1 : 0;
  const base = {
    slug: rec.slug, horizon: rec.horizon, entry: rec.entry, ts: rec.ts, resolvedUp,
    marketProb: rec.marketProb ?? null, modelVersion: rec.modelVersion ?? 1, scoredAt: new Date().toISOString(),
  };
  const rows = [];
  for (const p of rec.predictions || []) {
    const s = paper.score(p, resolvedUp);
    rows.push({
      ...base, strategy: p.strategy, side: p.side, price: p.price, fee: p.fee, shares: p.shares, stake: p.stake,
      quote: p.quote ?? null, depthOk: p.depthOk ?? null, won: s.won, pnl: s.pnl, modelProb: p.modelProb ?? null,
    });
  }
  for (const o of rec.maker || []) {
    const s = o.filled ? paper.score(o, resolvedUp) : { won: false, pnl: 0 };
    rows.push({
      ...base, strategy: o.strategy, side: o.side, price: o.bid, fee: 0, shares: o.shares, stake: o.stake,
      filled: !!o.filled, won: s.won, pnl: s.pnl,
    });
  }
  store.addScored(rec, rows);

  // Only v2 records carry v2 features. Learn after scoring, once per entry.
  if (rec.modelVersion === 2 && rec.features && rec.marketProb != null) {
    const key = keyOf(rec.slug, rec.entry);
    if (rec.entry === PRIMARY_ENTRY && rec.modelProb != null) model.recordOutOfSample(key, rec.modelProb, rec.marketProb, y);
    model.add(key, rec.features, rec.marketProb, y, { src: 'live' });
    model.save();
  }
  if (stopHit() && !state.stoppedReason) {
    state.stoppedReason = `Reached the ${settings.stopAfter}-round limit. Still recording; betting paused.`;
    note(state.stoppedReason);
  }
}

/**
 * Score every bet whose round has ended, however long ago. Catches up after
 * the laptop sleeps, the app is closed, or the network drops.
 */
const lastTried = new Map();
async function catchUp() {
  const now = Date.now();
  const due = new Map();
  for (const rec of store.unscored()) {
    const p = us.parseSlug(rec.slug);
    if (!p || p.endMs > now - 3000 || p.endMs < now - 29 * 86400000) continue;
    if (!due.has(rec.slug)) due.set(rec.slug, []);
    due.get(rec.slug).push(rec);
  }
  // Also log every recently closed round, bet on or not.
  for (const h of settings.horizons) {
    for (let back = 1; back <= 3; back++) {
      const slug = us.slugFor(new Date(now - back * h * 60000), h);
      if (!store.rounds.has(slug) && !due.has(slug)) due.set(slug, []);
    }
  }
  let budget = 12;
  for (const [slug, recs] of due) {
    if (budget-- <= 0) break;
    if (now - (lastTried.get(slug) || 0) < 15000) continue;
    lastTried.set(slug, now);
    let r;
    try { r = await us.fetchEvent(slug); } catch { continue; }
    if (!r || r.resolvedUp == null) continue;
    if (store.addRound({ ...r, harvestedAt: new Date().toISOString() })) {
      note(`resolved ${slug}: ${r.resolvedUp ? 'UP' : 'DOWN'}`);
    }
    for (const rec of recs) settle(rec, r.resolvedUp);
    lastTried.delete(slug);
  }
}

/**
 * v1 sometimes logged a result before the exchange had settled the round.
 * Re-check every round it scored against the official settlement, once.
 */
async function recheckOldOutcomes() {
  const slugs = store.needsCheck();
  if (!slugs.length) return;
  let fixed = 0;
  for (const slug of slugs) {
    if (us.parseSlug(slug)?.endMs < Date.now() - 29 * 86400000) continue;
    let r;
    try { r = await us.fetchEvent(slug); } catch { continue; }
    if (!r || r.settlementPrice == null || r.resolvedUp == null) continue;
    const was = store.rounds.get(slug)?.resolvedUp ?? store.scored.find((x) => x.slug === slug)?.resolvedUp ?? null;
    if (was !== r.resolvedUp) fixed++;
    store.recordCheck(slug, r.resolvedUp, was);
    await new Promise((z) => setTimeout(z, 200));
  }
  if (fixed) note(`re-checked old results: corrected ${fixed} round${fixed > 1 ? 's' : ''}`);
  state.corrected = (state.corrected || 0) + fixed;
}

// ---------------- history: backfill, backtest, warm start ----------------

function nextEntryInSecs() {
  const now = Date.now();
  let best = Infinity;
  for (const h of settings.horizons) {
    const end = us.roundStart(new Date(now), h).getTime() + h * 60000;
    for (const e of settings.entries) {
      const t = end - e * 1000 - now;
      if (t > -ENTRY_WINDOW * 1000) best = Math.min(best, Math.max(0, t));
    }
  }
  return best / 1000;
}

async function runHistory() {
  if (state.backfill.running || NO_BACKFILL) return;
  state.backfill = { ...state.backfill, running: true, error: null };
  try {
    await history.backfill(HIST_DIR, {
      horizons: [15, 5],
      onProgress: (p) => { state.backfill.done = p.done; state.backfill.total = p.total; },
    });
    // The backtest briefly uses the CPU; keep it clear of an entry time.
    while (nextEntryInSecs() < 25) await new Promise((r) => setTimeout(r, 5000));
    const hist = history.loadHistory(HIST_DIR);
    const bt = history.backtest(hist, { stake: settings.stake });
    let added = 0;
    for (const row of bt.rows) if (model.add(row.key, row.f, row.mkt, row.y, { src: 'history', refit: false })) added++;
    if (added) { model.fit(); model.save(); }
    delete bt.rows;
    backtestResult = bt;
    fs.writeFileSync(BACKTEST, JSON.stringify(bt));
    note(`history: ${bt.rounds} past rounds, ${added} new for the model`);
    state.backfill.rounds = bt.rounds;
    state.backfill.lastRun = new Date().toISOString();
  } catch (e) {
    state.backfill.error = e.message;
    note(`history: ${e.message}`);
  } finally {
    state.backfill.running = false;
  }
}

// ---------------- main loop ----------------

/** Sleep until the next poll, or just past the next entry time if sooner. */
function msUntilNext() {
  const now = Date.now();
  let wake = now + POLL_MS;
  for (const h of settings.horizons) {
    const end = us.roundStart(new Date(now), h).getTime() + h * 60000;
    for (const e of settings.entries) {
      const t = end - e * 1000 + 400;
      if (t > now + 200 && t < wake) wake = t;
    }
  }
  return Math.max(200, wake - now);
}

let lastCatchUp = 0;
async function loop() {
  for (;;) {
    if (settings.recording) {
      await refreshBrti();
      for (const h of settings.horizons) {
        try { await pollHorizon(h); state.lastError = null; }
        catch (e) { state.lastError = e.message; note(`${h}m error: ${e.message}`); }
      }
    }
    if (Date.now() - lastCatchUp > 8000) {
      lastCatchUp = Date.now();
      try { await catchUp(); } catch (e) { note(`catch-up: ${e.message}`); }
    }
    await new Promise((r) => setTimeout(r, msUntilNext()));
  }
}

// ---------------- api ----------------

const live = () => settings.horizons.map((h) => {
  const s = state.last[h];
  if (!s) return { horizon: h };
  const endMs = s.windowEnd ? Date.parse(s.windowEnd) : null;
  return {
    horizon: h, slug: s.slug, endMs, windowStart: s.windowStart, status: s.status,
    priceToBeat: s.priceToBeat, spot: s.spot, marketProb: s.marketProb, modelProb: s.modelProb,
    yesQuote: s.yesQuote, noQuote: s.noQuote, feeCoefficient: s.feeCoefficient,
    call: s.call, locked: lockedCall(s.slug),
  };
});

const statusOf = (rec) => rec.modelTrained == null ? null : { trained: rec.modelTrained, informative: !!rec.informative };

/** The call as placed at the latest entry time this round, if any yet. */
function lockedCall(slug) {
  for (const e of [...ALL_ENTRIES].sort((a, b) => a - b)) {
    const rec = store.preds.get(keyOf(slug, e));
    if (rec) {
      const c = paper.callFrom(rec.predictions || [], statusOf(rec));
      return c ? { ...c, entry: e } : null;
    }
  }
  return null;
}

/** Bets on rounds that have not settled yet, one entry per round. */
function riding() {
  const out = [];
  for (const rec of store.unscored().slice(-30)) {
    const p = us.parseSlug(rec.slug);
    if (p && p.endMs < Date.now() - 3600000) continue;
    out.push({
      slug: rec.slug, horizon: rec.horizon, entry: rec.entry, endMs: p?.endMs ?? null,
      marketProb: rec.marketProb, modelProb: rec.modelProb, priceToBeat: rec.priceToBeat ?? null,
      call: paper.callFrom(rec.predictions || [], statusOf(rec)),
      bets: (rec.predictions || []).map((b) => ({ strategy: b.strategy, side: b.side, price: b.price, stake: b.stake })),
      maker: (rec.maker || []).map((m) => ({ strategy: m.strategy, side: m.side, bid: m.bid, filled: !!m.filled })),
    });
  }
  return out.reverse();
}

function apiNow() {
  const sp = spotNow(), bench = model.benchmark();
  return {
    recording: settings.recording, stoppedReason: state.stoppedReason, error: state.lastError || store.lastError,
    spot: sp.spot, spotAt: sp.spotAt, live: live(), riding: riding(), serverTime: Date.now(),
    // Gate 1: until the model beats the market on live rounds, every call is unproven.
    proven: !!bench.beatsMarket, provenDetail: `${bench.n} of ${paper.MIN_TRAINED} live rounds checked`,
    counts: {
      rounds: store.rounds.size, bets: store.preds.size, scoredRounds: scoredRounds(),
      trained: model.trained, snapshots: store.snapshots,
    },
    backfill: state.backfill,
    corrections: [...store.checked].length ? { checked: store.checked.size, corrected: new Set(store.scored.filter((r) => r.recordedAs != null).map((r) => r.slug)).size } : null,
  };
}

let resultsCache = new Map();
/**
 * era 'new' (default): bets placed by v2 only. v1 priced bets off the event's
 * cached quotes, which trailed the book and in the last minute often showed
 * only one side at 1c or 99c; a handful of 1c long shots paying $990 each
 * swamp everything else. Those rows stay on disk and can be shown with 'all'.
 */
function apiResults(entry, horizon, era = 'new') {
  const ck = `${store.version}|${entry}|${horizon}|${era}|${backtestResult?.builtAt}`;
  if (resultsCache.has(ck)) return resultsCache.get(ck);
  const pass = (r) => (era === 'all' || r.modelVersion === 2)
    && (entry === 'all' || r.entry === Number(entry)) && (horizon === 'all' || r.horizon === Number(horizon));
  const rows = store.scored.filter(pass);
  const sum = paper.summarize(rows).map((s) => ({ ...s, about: paper.DESCRIBE[s.strategy] || '' }));
  const real = rows.filter((r) => !paper.BASELINES.has(r.strategy) && r.filled !== false);
  const byRound = new Map();
  for (const r of rows) {
    const k = keyOf(r.slug, r.entry);
    if (!byRound.has(k)) byRound.set(k, []);
    byRound.get(k).push(r);
  }
  const recent = [...byRound.values()].slice(-25).reverse().map((list) => ({
    slug: list[0].slug, horizon: list[0].horizon, entry: list[0].entry, resolvedUp: list[0].resolvedUp,
    pnl: list.filter((b) => b.filled !== false && !paper.BASELINES.has(b.strategy)).reduce((a, b) => a + b.pnl, 0),
    bets: list.filter((b) => b.filled !== false).map((b) => ({ strategy: b.strategy, side: b.side, price: b.price, won: b.won, pnl: b.pnl })),
  }));
  const bt = backtestResult ? {
    builtAt: backtestResult.builtAt, rounds: backtestResult.rounds, byHorizon: backtestResult.byHorizon,
    from: backtestResult.from, to: backtestResult.to,
    strategies: (backtestResult.breakdown?.[`${entry === '30' ? 'none' : entry}|${horizon}`] || [])
      .map((s) => ({ ...s, about: paper.DESCRIBE[s.strategy] || '' })),
    note: entry === '30' ? 'Past rounds only have one price a minute, so the 30s entry can only be tested live.' : null,
  } : null;
  const out = {
    stake: settings.stake, era,
    oldBets: era === 'all' ? 0 : store.scored.filter((r) => r.modelVersion !== 2).length,
    overall: {
      n: real.length, pnl: real.reduce((a, r) => a + r.pnl, 0),
      staked: real.reduce((a, r) => a + (r.stake || 0), 0),
      winRate: real.length ? real.filter((r) => r.won).length / real.length : null,
      needed: real.length ? real.reduce((a, r) => a + r.price + (r.fee || 0), 0) / real.length : null,
      rounds: new Set(rows.map((r) => r.slug)).size,
    },
    strategies: sum, recent, backtest: bt,
  };
  resultsCache = new Map([[ck, out]]);
  return out;
}

function apiModel() {
  const bench = model.benchmark();
  const v2 = store.scored.filter((r) => r.modelVersion === 2);
  const g2 = paper.calibrationGate(v2.filter((r) => r.strategy === 'model_direction' && r.entry === PRIMARY_ENTRY));
  const edgeRows = v2.filter((r) => r.strategy === 'model_edge');
  const edge = paper.summarize(edgeRows)[0] || null;
  const g1 = bench.beatsMarket, g2p = g2.pass;
  const g3 = !!(edge && edge.verdict === 'POSITIVE');
  let src = { live: 0, history: 0 };
  for (const r of model.rows.values()) src[r.src] = (src[r.src] || 0) + 1;
  return {
    trained: model.trained, trainedFrom: src, minTrained: paper.MIN_TRAINED,
    informative: model.isInformative(), disagreeSd: model.disagreeSd, fittedAt: model.fittedAt,
    weights: paper.FEATURE_KEYS.map((k) => ({ key: k, label: paper.LABEL[k], w: model.w[k] || 0 })),
    bias: model.b,
    benchmark: bench,
    calibration: g2.cal,
    edgeBets: edge ? { n: edge.n, pnl: edge.pnl, winRate: edge.winRate, verdict: edge.verdict, evidence: edge.evidence } : { n: 0 },
    gates: [
      { id: 1, name: 'Predicts better than the market', pass: g1,
        detail: bench.n < paper.MIN_TRAINED ? `needs ${paper.MIN_TRAINED}+ live rounds (has ${bench.n})` : bench.verdict,
        progress: bench.progress },
      { id: 2, name: 'Says 70%, wins 70%', pass: g2p, detail: g2.detail },
      { id: 3, name: 'Makes money after fees', pass: g3,
        detail: !edge ? 'no edge bets yet' : edge.n < 100 ? `needs 100+ edge bets (has ${edge.n})` : edge.verdict === 'POSITIVE' ? 'profit is beyond luck' : 'not proven yet',
        progress: edge?.evidence ?? 0 },
    ],
    backtest: backtestResult ? { gate1: backtestResult.gate1, gate2: { pass: backtestResult.gate2?.pass, detail: backtestResult.gate2?.detail, cal: backtestResult.gate2?.cal }, rounds: backtestResult.rounds } : null,
  };
}

const json = (res, obj, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

/**
 * Only this machine's own page may talk to the server.
 *  - Host must be 127.0.0.1 or localhost on our port, which defeats DNS
 *    rebinding (a web page pointing its own domain at 127.0.0.1).
 *  - Changes must be JSON with our custom header. Browsers will not send a
 *    custom header cross-site without a CORS preflight, which we never grant.
 *  - Origin, when sent, must be ours.
 */
const OK_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function allowed(req) {
  if (!OK_HOSTS.has(String(req.headers.host || '').toLowerCase())) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  if (origin && !OK_HOSTS.has(origin.replace(/^http:\/\//, '').toLowerCase())) return false;
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false;
  return req.headers['x-poly15'] === '1';
}

function applySettings(p) {
  if (typeof p.recording === 'boolean') {
    settings.recording = p.recording;
    if (p.recording) state.stoppedReason = null;
  }
  if (Number.isFinite(p.stake) && p.stake > 0 && p.stake <= 10000) settings.stake = p.stake;
  if (Number.isFinite(p.stopAfter) && p.stopAfter >= 0) {
    settings.stopAfter = Math.floor(p.stopAfter);
    settings.stopBaseline = scoredRounds();
    state.stoppedReason = null;
  }
  if (Array.isArray(p.entries)) {
    const e = p.entries.map(Number).filter((x) => ALL_ENTRIES.includes(x));
    // The 60s entry is the one the model is judged on; it always stays.
    settings.entries = [...new Set([...e, PRIMARY_ENTRY])].sort((a, b) => b - a);
  }
  if (Array.isArray(p.horizons)) {
    const h = p.horizons.map(Number).filter((x) => x === 5 || x === 15);
    if (h.length) settings.horizons = [...new Set(h)].sort((a, b) => b - a);
  }
  saveSettings();
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) { res.writeHead(403); return res.end('forbidden'); }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'ui.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/now') return json(res, apiNow());
    if (req.method === 'GET' && url.pathname === '/api/results') {
      return json(res, apiResults(url.searchParams.get('entry') || 'all', url.searchParams.get('horizon') || 'all',
        url.searchParams.get('era') === 'all' ? 'all' : 'new'));
    }
    if (req.method === 'GET' && url.pathname === '/api/model') return json(res, apiModel());
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return json(res, { ...settings, dataDir: DATA, allEntries: ALL_ENTRIES, primaryEntry: PRIMARY_ENTRY });
    }
    if (req.method === 'GET' && url.pathname === '/api/chart') {
      const rows = await chartCandles();
      const marks = settings.horizons.map((h) => {
        const s = state.last[h];
        return s ? { horizon: h, start: s.windowStart, end: s.windowEnd, priceToBeat: s.priceToBeat } : null;
      }).filter(Boolean);
      return json(res, { candles: rows, marks, spot: spotNow().spot });
    }
    if (req.method === 'GET' && url.pathname === '/api/log') return json(res, state.log.slice(-60).reverse());
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', () => {
        try { applySettings(JSON.parse(body || '{}')); json(res, settings); }
        catch (e) { json(res, { error: e.message }, 400); }
      });
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`poly15 on http://127.0.0.1:${PORT}`);
    console.log(`horizons ${settings.horizons.join('m, ')}m · entries ${settings.entries.join('s, ')}s · stake $${settings.stake} · data ${DATA}`);
    loop();
    setTimeout(() => recheckOldOutcomes().catch((e) => note(`re-check: ${e.message}`)), 3000);
    setTimeout(runHistory, 15000);
    setInterval(runHistory, BACKFILL_EVERY);
  });
}

module.exports = { allowed, applySettings, settle, apiResults, apiModel, apiNow, store, model, settings };
