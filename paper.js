'use strict';
/**
 * paper.js: paper trading, features, the learning model, and the statistics
 * that judge them.
 *
 * Nothing here can place a real order.
 *
 * Architecture note, the important one:
 *
 *   logit(p_model) = logit(p_market) + b + w . z
 *
 * The model does not predict the outcome from scratch. It predicts an
 * ADJUSTMENT to the market's own price. If it learns nothing, w and b stay
 * near zero, it reproduces the market exactly, finds no disagreement, and
 * places no bets. Silence is the failure mode, not confident nonsense.
 *
 * Since v2 the model is refit from scratch on every stored round (ridge
 * logistic regression, Newton's method) instead of nudged one round at a
 * time, and features are standardized so no single input dominates by scale.
 */

const fs = require('fs');

// Gates before the model is allowed to bet at all.
const MIN_TRAINED = Number(process.env.POLY15_MIN_TRAINED || 200);
const EDGE_MARGIN = Number(process.env.POLY15_EDGE_MARGIN || 0.02);
const MIN_PROB_SPREAD = Number(process.env.POLY15_MIN_SPREAD || 0.02);
const MAX_ROWS = 20000;
const RIDGE = 20;              // shrinkage toward "agree with the market"
const GATE1_RHO = 0.5;          // mixing scale of the sequential test (insensitive; 0.5–50 tested)

const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sigmoid = (z) => 1 / (1 + Math.exp(-clip(z, -30, 30)));
const logit = (p) => Math.log(clip(p, 1e-6, 1 - 1e-6) / (1 - clip(p, 1e-6, 1 - 1e-6)));
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const logLoss = (q, y) => -(y ? Math.log(clip(q, 1e-6, 1 - 1e-6)) : Math.log(clip(1 - q, 1e-6, 1 - 1e-6)));

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7). */
function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * The market's own probability that the round resolves Up.
 * yesQuote is the Yes ask; noQuote is the No ask, which is 1 - (Yes bid).
 * Both confirmed in docs.polymarket.us. The midpoint of ask and bid is the
 * market's estimate.
 */
function marketProb(snap) {
  const yesAsk = num(snap.yesQuote) ?? num(snap.yesPrice);
  const noAsk = num(snap.noQuote) ?? num(snap.noPrice);
  if (yesAsk != null && noAsk != null) {
    const yesBid = 1 - noAsk;
    return clip((yesAsk + yesBid) / 2, 0.02, 0.98);
  }
  if (yesAsk != null) return clip(yesAsk, 0.02, 0.98);
  if (noAsk != null) return clip(1 - noAsk, 0.02, 0.98);
  return 0.5;
}

/** Width of the quoted spread on the Yes side, 0 when unknown. */
function spreadWidth(snap) {
  const yesAsk = num(snap.yesQuote) ?? num(snap.yesPrice);
  const noAsk = num(snap.noQuote) ?? num(snap.noPrice);
  if (yesAsk == null || noAsk == null) return 0;
  return clip(Math.abs(yesAsk - (1 - noAsk)), 0, 0.5);
}

// BTC moves about $7 per sqrt(second) at $80k and 50% annual volatility.
// Used only before enough live readings exist to measure it.
const DEFAULT_VOL_FRAC = 0.5 / Math.sqrt(365.25 * 86400);

/**
 * Spot, volatility and momentum at time T (unix seconds) from 1-second BRTI
 * readings [{t, v}], oldest first. The same function serves live trading
 * and the backtest, so both see identical inputs.
 *
 *   vol      = standard deviation of 1s changes over the last 300s, $ per sqrt(s)
 *   momentum = the last 30s change, in units of what 30s normally moves
 */
function spotContext(points, T) {
  let hi = -1;
  for (let i = points.length - 1; i >= 0; i--) if (points[i].t <= T) { hi = i; break; }
  if (hi < 0 || T - points[hi].t > 15) return { spot: null, vol: null, momentum: 0, spotAt: null };
  const spot = points[hi].v;
  const win = [];
  for (let i = hi; i >= 0 && points[i].t >= T - 300; i--) win.push(points[i]);
  win.reverse();
  let vol = null;
  if (win.length >= 60) {
    const d = [];
    for (let i = 1; i < win.length; i++) {
      const dt = win[i].t - win[i - 1].t;
      if (dt > 0 && dt <= 5) d.push((win[i].v - win[i - 1].v) / Math.sqrt(dt));
    }
    if (d.length >= 30) {
      const m = d.reduce((a, x) => a + x, 0) / d.length;
      vol = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (d.length - 1));
    }
  }
  let momentum = 0;
  const back = win.filter((p) => p.t <= T - 30).pop();
  if (back && vol > 0) momentum = (spot - back.v) / (vol * Math.sqrt(T - back.t));
  return { spot, vol, momentum, spotAt: points[hi].t };
}

/**
 * Feature vector. Raw, interpretable units; the model standardizes them.
 * Deliberately excludes the market probability itself, which enters as the
 * offset rather than as a weight the model could lean on.
 *
 * `vol` is BTC's recent volatility in $ per sqrt(second).
 */
function features(snap, vol) {
  const horizonSecs = (snap.horizon || 15) * 60;
  const ptb = num(snap.priceToBeat);
  const spot = num(snap.spot);
  const secsLeft = clip(num(snap.secsToClose) ?? 0, 0, horizonSecs);
  const sigma = vol > 0 ? vol : (ptb || spot || 80000) * DEFAULT_VOL_FRAC;

  // How many "normal moves for the time left" BTC sits from the line.
  // Under a pure random walk P(Up) = Phi(distZ); the market should price that.
  let distZ = 0;
  if (spot != null && ptb != null) distZ = clip((spot - ptb) / (sigma * Math.sqrt(Math.max(secsLeft, 1))), -6, 6);
  const mkt = marketProb(snap);
  const fairGap = spot != null && ptb != null ? clip(logit(clip(normCdf(distZ), 0.01, 0.99)) - logit(mkt), -4, 4) : 0;

  const hour = new Date(snap.ts || Date.now()).getUTCHours() + new Date(snap.ts || Date.now()).getUTCMinutes() / 60;
  const ang = (2 * Math.PI * hour) / 24;

  return {
    distZ,
    fairGap,
    momentum: clip(num(snap.momentum) ?? 0, -4, 4),
    volLevel: clip(Math.log(sigma / ((ptb || spot || 80000) * DEFAULT_VOL_FRAC)), -2, 2),
    timeLeft: secsLeft / horizonSecs,
    spread: spreadWidth(snap),
    isFifteen: snap.horizon === 15 ? 1 : 0,
    hourSin: Math.sin(ang),
    hourCos: Math.cos(ang),
  };
}

const FEATURE_KEYS = ['distZ', 'fairGap', 'momentum', 'volLevel', 'timeLeft', 'spread', 'isFifteen', 'hourSin', 'hourCos'];

const LABEL = {
  distZ: 'BTC distance from the line',
  fairGap: 'random-walk odds vs market',
  momentum: 'last 30s direction',
  volLevel: 'how volatile right now',
  timeLeft: 'time remaining',
  spread: 'spread width',
  isFifteen: '15m vs 5m',
  hourSin: 'time of day (a)',
  hourCos: 'time of day (b)',
};

/**
 * Anytime-valid one-sided test that the mean of `xs` is above zero.
 *
 * A fixed "3 standard errors" rule is only valid if you look once. This app
 * looks every few seconds, forever, and with enough looks noise eventually
 * crosses any fixed line. The normal-mixture boundary (Robbins; de la Pena
 * et al. 2004) widens slowly with evidence so the chance of a false pass,
 * ever, stays below alpha no matter how often it is checked.
 *
 *   pass when  S >= sqrt((V + rho) * (ln((V + rho) / rho) + 2 ln(1/alpha)))
 *   with S = sum of x, V = sum of x^2.
 *
 * rho sets where the test is most sensitive: around V ~ rho.
 */
function seqTest(xs, { alpha = 0.01, rho = 1 } = {}) {
  let S = 0, V = 0;
  for (const x of xs) { S += x; V += x * x; }
  const n = xs.length;
  const bound = Math.sqrt((V + rho) * (Math.log((V + rho) / rho) + 2 * Math.log(1 / alpha)));
  const mean = n ? S / n : 0;
  let sd = 0;
  if (n > 1) sd = Math.sqrt(Math.max(0, (V - n * mean * mean) / (n - 1)));
  return {
    n, S, V, bound, mean, stderr: n ? sd / Math.sqrt(n) : null,
    pass: n > 0 && S >= bound,
    fail: n > 0 && S <= -bound,
    progress: bound > 0 ? S / bound : 0,       // 1.0 = boundary reached
  };
}

/** Solve A x = b for a small dense system (Gaussian elimination, partial pivoting). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;

/**
 * Ridge logistic regression on top of the market's own price, refit on every
 * stored round. Rows are keyed (round + entry time) so the same round is never
 * learned twice, whether it arrives live or from the history backfill.
 */
class Model {
  constructor(file) {
    this.file = file;
    this.rows = new Map();     // key -> { x: number[], o: logit(mkt), y, src }
    this.mean = FEATURE_KEYS.map(() => 0);
    this.sd = FEATURE_KEYS.map(() => 1);
    this.beta = new Array(FEATURE_KEYS.length + 1).fill(0);   // [bias, ...weights]
    this.oos = [];             // [key, lossModel, lossMarket], scored on predictions made BEFORE the outcome
    this.informative = false;
    this.disagreeSd = 0;
    this.fittedAt = null;
    this.load();
  }

  get trained() { return this.rows.size; }
  get b() { return this.beta[0]; }
  /** Weights per one standard deviation of each feature (log-odds). */
  get w() { return Object.fromEntries(FEATURE_KEYS.map((k, i) => [k, this.beta[i + 1]])); }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && j.version === 2) {
        for (const [k, x, o, y, src] of j.rows || []) this.rows.set(k, { x, o, y, src });
        this.oos = j.oos || [];
        this.fit();
      }
      // Anything older is the v1 online model. Its features and scaling no
      // longer exist, so it is ignored and the model starts fresh.
    } catch { /* first run */ }
  }

  save() {
    if (!this.file) return;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        version: 2, savedAt: new Date().toISOString(),
        beta: this.beta, mean: this.mean, sd: this.sd,
        rows: [...this.rows].map(([k, r]) => [k, r.x.map(r5), r5(r.o), r.y, r.src]),
        oos: this.oos.slice(-MAX_ROWS),
      }));
      fs.renameSync(tmp, this.file);
    } catch { /* best effort */ }
  }

  _z(x) { return x.map((v, i) => (v - this.mean[i]) / this.sd[i]); }

  _eta(z, o) {
    let e = o + this.beta[0];
    for (let i = 0; i < z.length; i++) e += this.beta[i + 1] * z[i];
    return e;
  }

  /** P(Up), built as an adjustment to the market's own probability. Pure. */
  prob(f, mktProb) {
    const x = FEATURE_KEYS.map((k) => f[k] || 0);
    return sigmoid(this._eta(this._z(x), logit(mktProb)));
  }

  /** Store one settled round. Returns false if it was already known. */
  add(key, f, mktProb, y, { src = 'live', refit = true } = {}) {
    if (this.rows.has(key)) return false;
    this.rows.set(key, { x: FEATURE_KEYS.map((k) => f[k] || 0), o: logit(mktProb), y: y ? 1 : 0, src });
    while (this.rows.size > MAX_ROWS) this.rows.delete(this.rows.keys().next().value);
    if (refit) this.fit();
    return true;
  }

  /**
   * Gate 1's raw material. modelProb must be the probability the model
   * published BEFORE the outcome was known, so this is honest out-of-sample.
   */
  recordOutOfSample(key, modelProb, mktProb, y) {
    // Burn-in: a model with fewer than MIN_TRAINED rounds is mostly noise, and
    // counting its early losses would only slow gate 1 down.
    if (this.trained < MIN_TRAINED) return;
    if (this.oos.some((r) => r[0] === key)) return;
    this.oos.push([key, r5(logLoss(modelProb, y)), r5(logLoss(mktProb, y))]);
    if (this.oos.length > MAX_ROWS) this.oos.shift();
  }

  /** Full refit: Newton's method on the penalized log-likelihood. */
  fit() {
    const rows = [...this.rows.values()];
    const k = FEATURE_KEYS.length;
    if (!rows.length) { this.beta = new Array(k + 1).fill(0); this.informative = false; return; }
    for (let j = 0; j < k; j++) {
      let m = 0;
      for (const r of rows) m += r.x[j];
      m /= rows.length;
      let s = 0;
      for (const r of rows) s += (r.x[j] - m) ** 2;
      s = Math.sqrt(s / rows.length);
      this.mean[j] = m;
      this.sd[j] = s > 1e-9 ? s : 1;
    }
    const Z = rows.map((r) => this._z(r.x));
    let beta = this.beta.slice();
    const pen = (bt) => RIDGE / 2 * bt.reduce((a, v) => a + v * v, 0);
    const loss = (bt) => {
      let L = pen(bt);
      for (let i = 0; i < rows.length; i++) {
        let e = rows[i].o + bt[0];
        for (let j = 0; j < k; j++) e += bt[j + 1] * Z[i][j];
        L += logLoss(sigmoid(e), rows[i].y);
      }
      return L;
    };
    let cur = loss(beta);
    for (let it = 0; it < 30; it++) {
      const g = beta.map((v) => RIDGE * v);
      const H = beta.map((_, a) => beta.map((__, c) => (a === c ? RIDGE : 0)));
      for (let i = 0; i < rows.length; i++) {
        const zi = [1, ...Z[i]];
        let e = rows[i].o;
        for (let j = 0; j <= k; j++) e += beta[j] * zi[j];
        const p = sigmoid(e), wgt = p * (1 - p), err = p - rows[i].y;
        for (let a = 0; a <= k; a++) {
          g[a] += err * zi[a];
          const wa = wgt * zi[a];
          for (let c = a; c <= k; c++) H[a][c] += wa * zi[c];
        }
      }
      for (let a = 0; a <= k; a++) for (let c = 0; c < a; c++) H[a][c] = H[c][a];
      const step = solve(H, g);
      let t = 1, next, nl;
      for (let h = 0; h < 20; h++) {
        next = beta.map((v, i) => v - t * step[i]);
        nl = loss(next);
        if (nl <= cur + 1e-12) break;
        t /= 2;
      }
      if (!(nl <= cur + 1e-12)) break;
      const moved = Math.max(...step.map((s) => Math.abs(s * t)));
      beta = next; cur = nl;
      if (moved < 1e-7) break;
    }
    this.beta = beta;
    this.fittedAt = new Date().toISOString();

    // Informative = it disagrees with the market by varying amounts. A model
    // whose disagreement is always the same number has found a constant
    // tilt, not a signal.
    const tail = rows.slice(-300);
    const tz = Z.slice(-300);
    const d = tail.map((r, i) => sigmoid(this._eta(tz[i], r.o)) - sigmoid(r.o));
    const m = d.reduce((a, x) => a + x, 0) / Math.max(1, d.length);
    this.disagreeSd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, d.length));
    this.informative = d.length >= 40 && this.disagreeSd >= MIN_PROB_SPREAD;
  }

  isInformative() { return this.informative; }

  /**
   * Gate 1: does the model predict better than the market's own prices, out
   * of sample? d = (market log loss) - (model log loss) per round; positive
   * means the model did better. Judged by the anytime-valid test above.
   */
  benchmark() {
    const d = this.oos.map((r) => r[2] - r[1]);
    const n = d.length;
    const t = seqTest(d, { alpha: 0.01, rho: GATE1_RHO });
    const avg = (i) => (n ? this.oos.reduce((a, r) => a + r[i], 0) / n : null);
    return {
      n, ready: n >= 30, lossModel: avg(1), lossMarket: avg(2),
      edge: t.mean, stderr: t.stderr, evidence: t.S, boundary: t.bound, progress: t.progress,
      beatsMarket: n >= MIN_TRAINED && t.pass,
      verdict: n < MIN_TRAINED ? 'too few' : t.pass ? 'BEATS MARKET' : t.fail ? 'worse than market' : 'no better than market yet',
    };
  }
}

/**
 * Calibration: when it says 70%, does it win 70%?
 * `claimed` is the average confidence of the calls that landed in the bucket.
 * `ok` = within 3 standard errors of what was claimed. Five bands are checked
 * at once, so 2.5 would flag an honest model about 6% of the time.
 */
function calibration(rows, buckets = 5) {
  const out = [];
  for (let i = 0; i < buckets; i++) {
    const lo = 0.5 + (i * 0.5) / buckets, hi = 0.5 + ((i + 1) * 0.5) / buckets;
    const inBand = rows.filter((r) => {
      const c = r.modelProb == null ? null : Math.max(r.modelProb, 1 - r.modelProb);
      return c != null && c >= lo && c < (i === buckets - 1 ? hi + 1e-9 : hi);
    });
    if (!inBand.length) { out.push({ lo, hi, n: 0 }); continue; }
    const wins = inBand.filter((r) => r.won).length;
    const claimed = inBand.reduce((a, r) => a + Math.max(r.modelProb, 1 - r.modelProb), 0) / inBand.length;
    const actual = wins / inBand.length;
    const se = Math.sqrt(Math.max(claimed * (1 - claimed), 0.01) / inBand.length);
    out.push({ lo, hi, n: inBand.length, claimed, actual, se, ok: Math.abs(actual - claimed) <= 3 * se });
  }
  return out;
}

/** Gate 2: enough calls, and every bucket with 30+ calls is within tolerance. */
function calibrationGate(rows) {
  const cal = calibration(rows);
  const n = rows.filter((r) => r.modelProb != null).length;
  const checked = cal.filter((c) => c.n >= 30);
  const bad = checked.filter((c) => !c.ok);
  return {
    n, cal, pass: n >= 200 && checked.length > 0 && bad.length === 0,
    detail: n < 200 ? `needs 200+ calls (has ${n})`
      : bad.length ? `${bad.length} confidence band${bad.length > 1 ? 's' : ''} off` : 'its odds match what happens',
  };
}

// ---------------- strategies ----------------

const FAVORITE_BAND = [0.80, 0.97];

const STRATEGIES = {
  always_up:     () => 'UP',
  always_down:   () => 'DOWN',
  follow_book:   (f, m) => (m > 0.5 ? 'UP' : 'DOWN'),
  fade_book:     (f, m) => (m > 0.5 ? 'DOWN' : 'UP'),
  momentum:      (f) => (f.distZ === 0 ? null : f.distZ > 0 ? 'UP' : 'DOWN'),
  fade_move:     (f) => (f.distZ === 0 ? null : f.distZ > 0 ? 'DOWN' : 'UP'),
  // Buy whichever side the market strongly favours, late. Wins often, wins
  // little; the question is whether the favourite is underpriced on average.
  late_favorite: (f, m, snap) => {
    const side = m >= 0.5 ? 'UP' : 'DOWN';
    const px = entryPrice(snap, side);
    return px != null && px >= FAVORITE_BAND[0] && px <= FAVORITE_BAND[1] ? side : null;
  },
};

/** Two mirror-image baselines; averaging them always gives 50%. */
const BASELINES = new Set(['always_up', 'always_down']);

const DESCRIBE = {
  always_up: 'Buy Up every round. A baseline.',
  always_down: 'Buy Down every round. A baseline.',
  follow_book: 'Buy whichever side the market favours.',
  fade_book: 'Buy the side the market says is less likely.',
  momentum: 'Bet BTC stays on the side of the line it is on now.',
  fade_move: 'Bet BTC crosses back over the line.',
  late_favorite: 'Buy the favourite only when it costs 80 to 97 cents.',
  model_direction: 'Buy the side the model thinks is likelier.',
  model_edge: 'Bet only when the model beats the price plus fee by 2 points.',
  follow_book_maker: 'Follow the market, but rest a limit order at the bid. No fee, may not fill.',
  model_direction_maker: 'Model direction, as a resting limit order at the bid. No fee, may not fill.',
};

const entryPrice = (snap, side) =>
  side === 'UP' ? (num(snap.yesQuote) ?? num(snap.yesPrice)) : (num(snap.noQuote) ?? num(snap.noPrice));

const takerFeePerShare = (p, coef) => (!coef || !Number.isFinite(p) ? 0 : coef * p * (1 - p));
const breakevenWinRate = (p, coef) => p + takerFeePerShare(p, coef);

/**
 * Walk the order book to spend `stake` dollars (price + taker fee) on one side.
 * The book is on the Yes instrument: Up buys Yes offers; Down buys No, which is
 * selling Yes into the bids at 1 - bid.
 */
function fillFromBook(book, side, stake, coef) {
  if (!book) return null;
  const levels = side === 'UP'
    ? (book.offers || []).map((l) => ({ px: l.px, qty: l.qty }))
    : (book.bids || []).map((l) => ({ px: Math.round((1 - l.px) * 1e6) / 1e6, qty: l.qty }));
  if (!levels.length) return null;
  let left = stake, shares = 0, cost = 0, fees = 0, used = 0;
  for (const l of levels) {
    if (left <= 1e-9) break;
    const per = l.px + takerFeePerShare(l.px, coef);
    const q = Math.min(l.qty, left / per);
    shares += q; cost += q * l.px; fees += q * takerFeePerShare(l.px, coef); left -= q * per; used++;
  }
  if (shares <= 0) return null;
  return {
    price: cost / shares, fee: fees / shares, shares, stake: stake - left,
    levelsUsed: used, depthOk: left <= 1e-6, topPx: levels[0].px,
  };
}

/**
 * Build every paper bet for one round, at entry time.
 * opts.book: the order book at entry, for realistic fills.
 */
function makePredictions(snap, vol, model, stake, opts = {}) {
  const f = features(snap, vol);
  const mkt = marketProb(snap);
  const coef = num(snap.feeCoefficient) ?? 0.0695;
  const out = [];

  const quoteFor = (side) => {
    const q = entryPrice(snap, side);
    if (q == null || q <= 0.005 || q >= 0.995) return null;
    const fill = opts.book ? fillFromBook(opts.book, side, stake, coef) : null;
    if (fill && fill.price > 0.005 && fill.price < 0.995) return { ...fill, quote: q };
    const fee = takerFeePerShare(q, coef);
    return { price: q, fee, shares: stake / (q + fee), stake, quote: q, depthOk: null };
  };

  const add = (strategy, side, extra = {}) => {
    const fq = quoteFor(side);
    if (!fq) return;
    out.push({
      strategy, side, price: fq.price, fee: fq.fee, shares: fq.shares, stake: fq.stake,
      quote: fq.quote, depthOk: fq.depthOk, ...extra,
    });
  };

  for (const [name, fn] of Object.entries(STRATEGIES)) {
    const side = fn(f, mkt, snap);
    if (side) add(name, side);
  }

  const pUp = model.prob(f, mkt);
  add('model_direction', pUp >= 0.5 ? 'UP' : 'DOWN', { modelProb: pUp, marketProb: mkt });

  // Edge-aware, gated on the model having earned the right to bet. Judged
  // against the price we would actually pay, fee included.
  if (model.trained >= MIN_TRAINED && model.isInformative()) {
    for (const side of ['UP', 'DOWN']) {
      const fq = quoteFor(side);
      if (!fq) continue;
      const need = fq.price + fq.fee;
      const mine = side === 'UP' ? pUp : 1 - pUp;
      if (mine > need + EDGE_MARGIN) {
        add('model_edge', side, { modelProb: mine, required: need, marketProb: mkt });
        break;
      }
    }
  }

  return { features: f, marketProb: mkt, modelProb: pUp, predictions: out };
}

/**
 * The one call shown to a person: always BUY on the side the model thinks
 * likelier, with its chance of winning, plus a separate verdict on the price.
 * Likely to win and worth the price are different questions: a 93% side at
 * 95 cents loses money over time, a 40% side at 30 cents makes it.
 *
 * verdict: 'learning' (too few rounds, or the model only copies the market;
 *                       the call is then the market's favourite at the market's odds),
 *          'good'     (model_edge bet this side: worth more than price + fee + margin),
 *          'pricey'   (it is not).
 * underdog: set when the good price is on the less likely side instead.
 * `status` is { trained, informative }; null when unknown.
 * `wins` is the profit in dollars if the call is right; a loss costs the stake.
 */
function callFrom(predictions, status) {
  const e = predictions.find((b) => b.strategy === 'model_edge');
  const learning = !e && status && (status.trained < MIN_TRAINED || !status.informative);
  // While learning, the model's numbers are noise, so the call is the market's
  // favourite at the market's odds (follow_book is exactly that bet).
  const md = predictions.find((b) => b.strategy === 'model_direction');
  const fav = learning && md && md.marketProb != null && predictions.find((b) => b.strategy === 'follow_book');
  const d = fav || md;
  if (!d) return null;
  const pUp = fav ? md.marketProb : d.modelProb;
  if (pUp == null) return null;
  const prob = d.side === 'UP' ? pUp : 1 - pUp;
  const verdict = learning ? 'learning' : e && e.side === d.side ? 'good' : 'pricey';
  return {
    side: d.side, strategy: d.strategy, prob, price: d.price, fee: d.fee, need: d.price + d.fee, stake: d.stake,
    wins: d.shares - d.stake, verdict, trained: status ? status.trained : null, minTrained: MIN_TRAINED,
    margin: EDGE_MARGIN,
    underdog: e && e.side !== d.side ? { side: e.side, prob: e.modelProb, need: e.price + e.fee } : null,
  };
}

/**
 * Limit orders resting at the bid. Makers pay no fee, but only get filled when
 * someone sells to them, which happens most when the price is moving against
 * them. Simulated conservatively: filled only if a LATER quote shows the
 * other side trading strictly through our price.
 */
function makerOrders(snap, mkt, pUp, stake) {
  const yesAsk = num(snap.yesQuote), noAsk = num(snap.noQuote);
  if (yesAsk == null || noAsk == null) return [];
  const bidFor = (side) => (side === 'UP' ? 1 - noAsk : 1 - yesAsk);   // Yes bid / No bid
  const out = [];
  const add = (strategy, side) => {
    const bid = Math.round(bidFor(side) * 1e4) / 1e4;
    if (bid > 0.01 && bid < 0.99) out.push({ strategy, side, bid, stake, shares: stake / bid, filled: false });
  };
  add('follow_book_maker', mkt > 0.5 ? 'UP' : 'DOWN');
  add('model_direction_maker', pUp >= 0.5 ? 'UP' : 'DOWN');
  return out;
}

/** Would this resting order have been filled by a later quote? */
function makerFillsAt(order, laterSnap) {
  if (order.side === 'UP') {
    const ask = num(laterSnap.yesQuote);
    return ask != null && ask < order.bid - 1e-9;
  }
  const ask = num(laterSnap.noQuote);
  return ask != null && ask < order.bid - 1e-9;
}

/** Score one bet. P&L is in dollars. */
function score(pred, resolvedUp) {
  const won = (pred.side === 'UP') === (resolvedUp === 1);
  const shares = pred.shares ?? 1;
  const stake = pred.stake ?? (pred.price + pred.fee);
  return { won, pnl: (won ? shares : 0) - stake };
}

/**
 * Per-strategy results. The verdict uses the anytime-valid test on return per
 * dollar staked, with the false-alarm budget split across the strategies on
 * screen, so a lucky streak in one of ten coinflips does not read as profit.
 */
function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.strategy)) by.set(r.strategy, []);
    by.get(r.strategy).push(r);
  }
  const k = Math.max(1, by.size);
  const out = [];
  for (const [name, all] of by) {
    const list = all.filter((x) => x.filled !== false);
    const n = list.length;
    const fillRate = all.length && all.some((x) => x.filled === false) ? n / all.length : null;
    if (!n) { out.push({ strategy: name, n: 0, offered: all.length, fillRate: 0, verdict: 'too few' }); continue; }
    const wins = list.filter((x) => x.won).length;
    const pnl = list.reduce((a, x) => a + x.pnl, 0);
    const staked = list.reduce((a, x) => a + (x.stake ?? 0), 0);
    const need = list.reduce((a, x) => a + x.price + (x.fee || 0), 0) / n;
    const mean = pnl / n;
    const sd = Math.sqrt(list.reduce((a, x) => a + (x.pnl - mean) ** 2, 0) / Math.max(1, n - 1));
    const t = seqTest(list.map((x) => x.pnl / (x.stake || 1)), { alpha: 0.05 / k, rho: 100 });
    out.push({
      strategy: name, n, offered: all.length, fillRate, wins, winRate: wins / n, breakeven: need,
      pnl, pnlPerBet: mean, staked, roi: staked ? pnl / staked : 0, stderr: sd / Math.sqrt(n),
      evidence: t.progress,
      verdict: n < 100 ? 'too few' : t.pass ? 'POSITIVE' : t.fail ? 'negative' : 'noise',
    });
  }
  return out.sort((a, b) => (b.pnlPerBet ?? -1e9) - (a.pnlPerBet ?? -1e9));
}

module.exports = {
  callFrom, features, FEATURE_KEYS, LABEL, Model, STRATEGIES, BASELINES, DESCRIBE, entryPrice, makePredictions,
  score, summarize, sigmoid, logit, clip, marketProb, spreadWidth, calibration, calibrationGate,
  takerFeePerShare, breakevenWinRate, num, normCdf, spotContext, seqTest, fillFromBook,
  makerOrders, makerFillsAt, logLoss,
  MIN_TRAINED, EDGE_MARGIN, MIN_PROB_SPREAD, FAVORITE_BAND,
};
