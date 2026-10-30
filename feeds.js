'use strict';
/**
 * feeds.js: record BTC prices from the big exchanges once a second, next to
 * the BRTI index the rounds settle on. Record only: nothing bets on these.
 *
 * The question it answers: does any exchange move before BRTI does? If one
 * leads by a few seconds, that is information the market may not have priced
 * yet, and it is the best-documented edge in these short rounds.
 */

const fs = require('fs');
const path = require('path');

const SOURCES = {
  coinbase: { url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker', px: (j) => Number(j.price) },
  kraken: { url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', px: (j) => Number(Object.values(j.result || {})[0]?.c?.[0]) },
  binanceus: { url: 'https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD', px: (j) => Number(j.price) },
};
const NAMES = { coinbase: 'Coinbase', kraken: 'Kraken', binanceus: 'Binance.US' };

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

class Feeds {
  constructor(dir) {
    this.dir = path.join(dir, 'feeds');
    fs.mkdirSync(this.dir, { recursive: true });
    this.timer = null;
    this.errors = {};
    this.last = {};
  }
  get running() { return !!this.timer; }
  start() {
    if (this.timer) return;
    const tick = async () => {
      const t = Date.now();
      const row = { t };
      await Promise.all(Object.entries(SOURCES).map(async ([k, s]) => {
        try {
          const ctl = new AbortController();
          const kill = setTimeout(() => ctl.abort(), 900);
          const r = await fetch(s.url, { signal: ctl.signal, headers: { 'user-agent': 'poly15' } });
          clearTimeout(kill);
          const v = s.px(await r.json());
          if (Number.isFinite(v) && v > 0) { row[k] = v; this.last[k] = { t, v }; }
        } catch (e) { this.errors[k] = (this.errors[k] || 0) + 1; }
      }));
      if (Object.keys(row).length > 1) this.append('ex', row);
    };
    this.timer = setInterval(tick, 1000);
    tick();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  /** BRTI seconds come from the server's own 1s feed. */
  brti(points) { for (const p of points) this.append('brti', { t: p.t * 1000, brti: p.v }); }
  append(kind, row) {
    try { fs.appendFileSync(path.join(this.dir, `${kind}-${day(row.t)}.jsonl`), JSON.stringify(row) + '\n'); } catch {}
  }
  load(kind, from, to) {
    const out = [];
    for (let d = Date.parse(day(from)); d <= to; d += 86400000) {
      const f = path.join(this.dir, `${kind}-${day(d)}.jsonl`);
      if (!fs.existsSync(f)) continue;
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!l) continue;
        try { const r = JSON.parse(l); if (r.t >= from && r.t <= to) out.push(r); } catch {}
      }
    }
    return out;
  }
}

/**
 * For each exchange, how well its price change k seconds ago lines up with
 * BRTI's change now. The k with the strongest match is how far it leads.
 * A lead of 0 means it moves together with BRTI: no head start.
 */
function leadLag(feeds, from, to, maxLag = 10) {
  const brti = new Map();
  for (const r of feeds.load('brti', from, to)) brti.set(Math.round(r.t / 1000), r.brti);
  const ex = feeds.load('ex', from, to);
  const out = { seconds: brti.size, sources: [] };
  if (brti.size < 600) return { ...out, note: 'Needs at least 10 minutes of recording.' };
  for (const k of Object.keys(SOURCES)) {
    const s = new Map();
    for (const r of ex) if (r[k] != null) s.set(Math.round(r.t / 1000), r[k]);
    if (s.size < 600) { out.sources.push({ key: k, name: NAMES[k], seconds: s.size, note: 'not enough data' }); continue; }
    const lags = [];
    for (let lag = 0; lag <= maxLag; lag++) {
      const xs = [], ys = [];
      for (const [t, b] of brti) {
        const b1 = brti.get(t - 1), e0 = s.get(t - lag), e1 = s.get(t - lag - 1);
        if (b1 == null || e0 == null || e1 == null) continue;
        xs.push(e0 - e1); ys.push(b - b1);
      }
      lags.push({ lag, r: corr(xs, ys), n: xs.length });
    }
    const best = lags.reduce((a, b) => (b.r > a.r ? b : a));
    // Spread of prices: how far this exchange typically sits from BRTI.
    const gaps = [];
    for (const [t, b] of brti) { const e = s.get(t); if (e != null) gaps.push(e - b); }
    out.sources.push({
      key: k, name: NAMES[k], seconds: s.size, bestLag: best.lag, bestR: best.r, sameSecondR: lags[0].r,
      lags, medianGap: gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null,
    });
  }
  return out;
}

function corr(xs, ys) {
  const n = xs.length;
  if (n < 30) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

module.exports = { Feeds, leadLag, SOURCES, NAMES, corr };
