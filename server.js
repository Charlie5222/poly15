'use strict';
/**
 * server.js — poly15. Records Polymarket US BTC up/down rounds, paper trades
 * them, and serves the UI.
 *
 * Read-only against the market: public data, no key, no wallet, no orders.
 * Binds to 127.0.0.1 only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const us = require('./us');
const paper = require('./paper');

const DATA = process.env.POLY15_DATA || path.join(__dirname, 'data');
const SNAP = path.join(DATA, 'snapshots.jsonl');
const ROUNDS = path.join(DATA, 'rounds.jsonl');
const PREDS = path.join(DATA, 'predictions.jsonl');
const SCORED = path.join(DATA, 'scored.jsonl');
const MODEL = path.join(DATA, 'model.json');
const SETTINGS = path.join(DATA, 'settings.json');
const PORT = Number(process.env.PORT || 18790);
const POLL_MS = Number(process.env.POLL_MS || 10000);

fs.mkdirSync(DATA, { recursive: true });

const append = (f, o) => { try { fs.appendFileSync(f, JSON.stringify(o) + '\n'); } catch (e) { state.lastError = e.message; } };
const readJSONL = (f) => {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

const DEFAULTS = { recording: true, horizons: [15, 5], entrySecs: 60, stake: 10, stopAfter: 0 };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) }; } catch {}
const saveSettings = () => { try { fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); } catch {} };

const state = { startedAt: new Date().toISOString(), polls: 0, lastError: null, last: {}, log: [], stoppedReason: null };
const note = (m) => { state.log.push({ ts: new Date().toISOString(), m }); if (state.log.length > 300) state.log.shift(); };

const model = new paper.Model(MODEL);
const resolved = new Set(readJSONL(ROUNDS).map((r) => r.slug));
const predicted = new Set(readJSONL(PREDS).map((p) => p.slug));
const scoredSet = new Set(readJSONL(SCORED).map((r) => r.slug));

// Rolling BTC history, for the volatility scaling and the chart.
const spotHist = [];                       // { t, v }
const prevSnap = {};                       // horizon -> previous snapshot

/** Standard deviation of BTC change between consecutive samples, in dollars. */
function recentVol() {
  if (spotHist.length < 8) return null;
  const d = [];
  for (let i = 1; i < spotHist.length; i++) d.push(spotHist[i].v - spotHist[i - 1].v);
  const mean = d.reduce((a, x) => a + x, 0) / d.length;
  return Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, d.length - 1));
}

let spotCache = { v: null, at: 0 };
async function fetchSpot() {
  if (Date.now() - spotCache.at < 5000) return spotCache.v;
  try {
    const j = await us.getJSON('https://api.coinbase.com/v2/prices/BTC-USD/spot', { retries: 1, timeoutMs: 6000 });
    const v = Number(j?.data?.amount);
    spotCache = { v: Number.isFinite(v) ? v : null, at: Date.now() };
    if (spotCache.v) {
      spotHist.push({ t: Date.now(), v: spotCache.v });
      if (spotHist.length > 240) spotHist.shift();
    }
  } catch { spotCache = { v: null, at: Date.now() }; }
  return spotCache.v;
}

// One-minute candles from Coinbase. Free, keyless, refreshed sparingly.
let candleCache = { rows: [], at: 0 };
async function fetchCandles() {
  if (Date.now() - candleCache.at < 45000 && candleCache.rows.length) return candleCache.rows;
  try {
    const j = await us.getJSON('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60',
      { retries: 1, timeoutMs: 8000 });
    if (Array.isArray(j)) {
      // [time, low, high, open, close, volume], newest first
      const rows = j.map((r) => ({ t: r[0] * 1000, low: r[1], high: r[2], open: r[3], close: r[4], vol: r[5] }))
        .filter((r) => Number.isFinite(r.open) && Number.isFinite(r.close))
        .sort((a, b) => a.t - b.t)
        .slice(-120);
      if (rows.length) candleCache = { rows, at: Date.now() };
    }
  } catch { candleCache.at = Date.now(); }
  return candleCache.rows;
}

const totalBets = () => predicted.size;
const stopHit = () => settings.stopAfter > 0 && scoredSet.size >= settings.stopAfter;

async function pollHorizon(mins) {
  const now = new Date();
  const r = await us.fetchRound(now, mins);
  if (!r) { note(`${mins}m: round not listed yet`); return; }

  const endMs = r.windowEnd ? Date.parse(r.windowEnd) : null;
  const secsToClose = endMs ? Math.round((endMs - now.getTime()) / 1000) : null;
  const spot = await fetchSpot();
  const vol = recentVol();

  const prev = prevSnap[mins];
  const ptb = r.priceToBeat;
  let momentum = 0;
  if (spot != null && prev?.spot != null && vol && vol > 0) momentum = (spot - prev.spot) / vol;

  const snap = { ts: now.toISOString(), secsToClose, spot, momentum, vol, ...r };
  append(SNAP, snap);
  state.last[mins] = { ...snap, marketProb: paper.marketProb(snap) };
  state.polls++;

  const inWindow = secsToClose != null && secsToClose <= settings.entrySecs && secsToClose > 5;
  if (settings.recording && !stopHit() && inWindow && !predicted.has(r.slug) && r.status === 'MARKET_STATUS_OPEN') {
    const made = paper.makePredictions(snap, vol, model, settings.stake);
    if (made.predictions.length) {
      append(PREDS, {
        slug: r.slug, horizon: mins, ts: now.toISOString(), secsToClose,
        features: made.features, marketProb: made.marketProb, modelProb: made.modelProb,
        modelTrained: model.trained, informative: model.isInformative(),
        stake: settings.stake, predictions: made.predictions,
      });
      predicted.add(r.slug);
      note(`bets placed on ${r.slug}`);
    }
  }
  prevSnap[mins] = snap;
}

function settleRound(slug, resolvedUp) {
  if (scoredSet.has(slug)) return;
  const rec = readJSONL(PREDS).find((p) => p.slug === slug);
  if (!rec) return;
  for (const p of rec.predictions) {
    const s = paper.score(p, resolvedUp);
    append(SCORED, {
      slug, horizon: rec.horizon, ts: rec.ts, strategy: p.strategy, side: p.side,
      price: p.price, fee: p.fee, shares: p.shares, stake: p.stake,
      resolvedUp, won: s.won, pnl: s.pnl,
      modelProb: p.modelProb ?? null, marketProb: rec.marketProb ?? null,
      scoredAt: new Date().toISOString(),
    });
  }
  // Train only after scoring, and only once per round.
  if (rec.features && rec.marketProb != null) {
    model.train(rec.features, rec.marketProb, resolvedUp === 1 ? 1 : 0);
    model.save();
  }
  scoredSet.add(slug);
  if (stopHit() && !state.stoppedReason) {
    state.stoppedReason = `Reached the ${settings.stopAfter}-round limit. Still recording; betting paused.`;
    note(state.stoppedReason);
  }
}

async function harvest(mins) {
  const now = new Date();
  for (let back = 1; back <= 4; back++) {
    const d = new Date(now.getTime() - back * mins * 60000);
    const slug = us.slugFor(d, mins);
    if (resolved.has(slug)) continue;
    let r;
    try { r = await us.fetchRound(d, mins); } catch { continue; }
    if (!r || r.resolvedUp == null) continue;
    append(ROUNDS, { ...r, harvestedAt: new Date().toISOString() });
    resolved.add(slug);
    note(`resolved ${slug}: ${r.resolvedUp ? 'UP' : 'DOWN'}`);
    settleRound(slug, r.resolvedUp);
  }
}

async function loop() {
  for (;;) {
    if (settings.recording) {
      for (const h of settings.horizons) {
        try { await pollHorizon(h); state.lastError = null; }
        catch (e) { state.lastError = e.message; note(`${h}m error: ${e.message}`); }
        try { await harvest(h); } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ---------------- api ----------------


/** Bets placed on rounds that have not settled yet. */
function openBets() {
  return readJSONL(PREDS)
    .filter((p) => !scoredSet.has(p.slug))
    .slice(-20)
    .map((p) => ({
      slug: p.slug, horizon: p.horizon, ts: p.ts, secsToClose: p.secsToClose,
      marketProb: p.marketProb, modelProb: p.modelProb, stake: p.stake,
      bets: (p.predictions || []).map((b) => ({
        strategy: b.strategy, side: b.side, price: b.price,
        shares: b.shares, stake: b.stake,
      })),
    }))
    .reverse();
}

function apiDashboard() {
  const rounds = readJSONL(ROUNDS);
  return {
    recording: settings.recording,
    stoppedReason: state.stoppedReason,
    polls: state.polls,
    error: state.lastError,
    horizons: settings.horizons,
    live: settings.horizons.map((h) => {
      const s = state.last[h];
      if (!s) return { horizon: h };
      return {
        horizon: h, slug: s.slug, secsToClose: s.secsToClose, status: s.status,
        priceToBeat: s.priceToBeat, spot: s.spot, marketProb: s.marketProb,
        yesQuote: s.yesQuote, noQuote: s.noQuote, feeCoefficient: s.feeCoefficient,
        indexSymbol: s.indexSymbol,
      };
    }),
    openBets: openBets(),
    counts: {
      rounds: rounds.length,
      byHorizon: Object.fromEntries(settings.horizons.map((h) => [h, rounds.filter((r) => r.horizon === h).length])),
      bets: predicted.size, scored: scoredSet.size, trained: model.trained,
      snapshots: fs.existsSync(SNAP) ? readJSONL(SNAP).length : 0,
    },
  };
}

function apiPaper() {
  const rows = readJSONL(SCORED);
  const sum = paper.summarize(rows);
  const byRound = new Map();
  for (const r of rows) {
    if (!byRound.has(r.slug)) byRound.set(r.slug, []);
    byRound.get(r.slug).push(r);
  }
  const recent = [...byRound.entries()].slice(-40).reverse().map(([slug, list]) => ({
    slug, horizon: list[0]?.horizon, resolvedUp: list[0]?.resolvedUp,
    bets: list.map((b) => ({ strategy: b.strategy, side: b.side, price: b.price, won: b.won, pnl: b.pnl })),
  }));
  const headline = sum.find((s) => s.strategy === 'model_edge')
    || sum.find((s) => s.strategy === 'model_direction') || sum[0] || null;
  const wins = rows.filter((r) => r.won).length;
  const needed = rows.length ? rows.reduce((a, r) => a + r.price + r.fee, 0) / rows.length : null;
  // The two baselines are mirror images: always_up wins exactly when
  // always_down loses, so including both drags any overall average to 50%.
  // Report the overall figure and the same figure without them.
  const real = rows.filter((r) => r.strategy !== 'always_up' && r.strategy !== 'always_down');
  const realWins = real.filter((r) => r.won).length;
  return {
    stake: settings.stake,
    totalPnl: rows.reduce((a, r) => a + r.pnl, 0),
    overall: {
      n: rows.length, wins, winRate: rows.length ? wins / rows.length : null, needed,
      realN: real.length, realWinRate: real.length ? realWins / real.length : null,
      realNeeded: real.length ? real.reduce((a, r) => a + r.price + r.fee, 0) / real.length : null,
    },
    strategies: sum, recent, headline, open: openBets(),
    feeNote: 'needed = the win rate each strategy had to hit just to break even on the prices it actually paid.',
  };
}

function apiLearn() {
  const rows = readJSONL(SCORED).filter((r) => r.strategy === 'model_direction');
  const bench = model.benchmark();
  return {
    trained: model.trained,
    minTrained: paper.MIN_TRAINED,
    informative: model.isInformative(),
    learningRate: model.lr,
    weights: paper.FEATURE_KEYS.map((k) => ({ key: k, label: paper.LABEL[k], w: model.w[k] || 0 })),
    bias: model.b,
    benchmark: bench,
    calibration: paper.calibration(rows),
    directionCalls: { n: rows.length, wins: rows.filter((r) => r.won).length },
    gates: [
      { id: 1, name: 'Beats the market as a predictor',
        pass: !!bench.beatsMarket, detail: bench.ready ? bench.verdict : `needs 200+ rounds (has ${bench.n || 0})` },
      { id: 2, name: 'Says 70% and wins 70%',
        pass: false, detail: rows.length < 200 ? `needs 200+ calls (has ${rows.length})` : 'check the calibration table' },
      { id: 3, name: 'Makes money after fees',
        pass: false, detail: 'only meaningful once gates 1 and 2 pass' },
    ],
  };
}

const json = (res, obj, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'ui.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(res, apiDashboard());
    if (req.method === 'GET' && url.pathname === '/api/paper') return json(res, apiPaper());
    if (req.method === 'GET' && url.pathname === '/api/learn') return json(res, apiLearn());
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, settings);
    if (req.method === 'GET' && url.pathname === '/api/candles') {
      const rows = await fetchCandles();
      const marks = settings.horizons.map((h) => {
        const s = state.last[h];
        return s ? { horizon: h, start: s.windowStart, end: s.windowEnd, priceToBeat: s.priceToBeat } : null;
      }).filter(Boolean);
      return json(res, { candles: rows, marks, spot: spotCache.v });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          if (typeof p.recording === 'boolean') {
            settings.recording = p.recording;
            if (p.recording) state.stoppedReason = null;
          }
          if (Number.isFinite(p.stake) && p.stake > 0 && p.stake <= 10000) settings.stake = p.stake;
          if (Number.isFinite(p.stopAfter) && p.stopAfter >= 0) settings.stopAfter = Math.floor(p.stopAfter);
          if (Number.isFinite(p.entrySecs) && p.entrySecs >= 10 && p.entrySecs <= 600) settings.entrySecs = Math.floor(p.entrySecs);
          if (Array.isArray(p.horizons)) {
            const h = p.horizons.map(Number).filter((x) => x === 5 || x === 15);
            if (h.length) settings.horizons = [...new Set(h)].sort((a, b) => b - a);
          }
          saveSettings();
          json(res, settings);
        } catch (e) { json(res, { error: e.message }, 400); }
      });
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`poly15 on http://127.0.0.1:${PORT}`);
  console.log(`horizons ${settings.horizons.join('m, ')}m · stake $${settings.stake} · data ${DATA}`);
  loop();
});
