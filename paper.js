'use strict';
/**
 * paper.js — paper trading, features, and the learning model.
 *
 * Nothing here can place a real order.
 *
 * Architecture note, the important one:
 *
 *   logit(p_model) = logit(p_market) + w . x + b
 *
 * The model does not predict the outcome from scratch. It predicts an
 * ADJUSTMENT to the market's own price. If it learns nothing, w and b stay
 * near zero, it reproduces the market exactly, finds no disagreement, and
 * places no bets. Silence is the failure mode, not confident nonsense.
 */

const fs = require('fs');

// Gates before the model is allowed to bet at all.
const MIN_TRAINED = Number(process.env.POLY15_MIN_TRAINED || 200);
const EDGE_MARGIN = Number(process.env.POLY15_EDGE_MARGIN || 0.02);
const MIN_PROB_SPREAD = Number(process.env.POLY15_MIN_SPREAD || 0.02);

const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sigmoid = (z) => 1 / (1 + Math.exp(-clip(z, -30, 30)));
const logit = (p) => Math.log(clip(p, 1e-6, 1 - 1e-6) / (1 - clip(p, 1e-6, 1 - 1e-6)));
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

/**
 * The market's own probability that the round resolves Up.
 * Buying No at its ask implies a Yes bid of (1 - noAsk), so the Yes midpoint
 * is the average of the Yes ask and that implied bid.
 */
function marketProb(snap) {
  const yesAsk = num(snap.yesQuote) ?? num(snap.yesPrice);
  const noAsk = num(snap.noQuote) ?? num(snap.noPrice);
  if (yesAsk != null && noAsk != null) {
    const yesBid = 1 - noAsk;
    return clip((yesAsk + yesBid) / 2, 0.02, 0.98);
  }
  if (yesAsk != null) return clip(yesAsk, 0.02, 0.98);
  return 0.5;
}

/** Width of the quoted spread on the Yes side, 0 when unknown. */
function spreadWidth(snap) {
  const yesAsk = num(snap.yesQuote) ?? num(snap.yesPrice);
  const noAsk = num(snap.noQuote) ?? num(snap.noPrice);
  if (yesAsk == null || noAsk == null) return 0;
  return clip(Math.abs(yesAsk - (1 - noAsk)), 0, 0.5);
}

/**
 * Feature vector. Deliberately excludes the market probability, which enters
 * as the offset rather than as a weight the model could lean on.
 *
 * `vol` is the recent standard deviation of BTC moves per sample, in dollars.
 */
function features(snap, vol) {
  const horizonSecs = (snap.horizon || 15) * 60;
  const ptb = num(snap.priceToBeat);
  const spot = num(snap.spot);
  const secsLeft = num(snap.secsToClose) ?? 0;
  const elapsed = Math.max(1, horizonSecs - secsLeft);

  // How far BTC has moved, measured in units of how far it normally moves in
  // that much time. A $20 move is huge in a calm hour and noise in a wild one;
  // this is the feature that lets the model tell those apart.
  let moveZ = 0;
  if (spot != null && ptb != null && vol && vol > 0) {
    const samples = Math.max(1, elapsed / 15);        // polls are ~15s apart
    const expected = vol * Math.sqrt(samples);
    moveZ = clip((spot - ptb) / Math.max(expected, 1e-6), -4, 4);
  } else if (spot != null && ptb) {
    moveZ = clip(((spot - ptb) / ptb) * 2000, -4, 4);  // fallback before vol exists
  }

  const hour = new Date(snap.ts || Date.now()).getUTCHours();
  const ang = (2 * Math.PI * hour) / 24;

  return {
    moveZ: moveZ / 4,
    momentum: clip(num(snap.momentum) ?? 0, -4, 4) / 4,
    vol: clip((vol || 0) / Math.max(1, (ptb || 80000) * 0.0005), 0, 3) / 3,
    timeLeft: clip(secsLeft / horizonSecs, 0, 1),
    spread: spreadWidth(snap) * 4,
    isFifteen: snap.horizon === 15 ? 1 : 0,
    hourSin: Math.sin(ang),
    hourCos: Math.cos(ang),
  };
}

const FEATURE_KEYS = ['moveZ', 'momentum', 'vol', 'timeLeft', 'spread', 'isFifteen', 'hourSin', 'hourCos'];

const LABEL = {
  moveZ: 'BTC move (volatility-scaled)', momentum: 'direction of travel',
  vol: 'how volatile right now', timeLeft: 'time remaining',
  spread: 'spread width', isFifteen: '15m vs 5m',
  hourSin: 'time of day (a)', hourCos: 'time of day (b)',
};

/** Online logistic regression on top of the market's own price. */
class Model {
  constructor(file) {
    this.file = file;
    this.w = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0]));
    this.b = 0;
    this.trained = 0;
    this.lr0 = 0.10;
    this.tau = 1200;       // decay slowly: the signal is weak and needs many rounds
    this.l2 = 3e-5;        // light shrinkage; heavy L2 crushes a genuine small edge
    this.recent = [];
    // Rolling scorecard: how well the model and the market each predicted.
    this.lossModel = [];
    this.lossMarket = [];
    this.load();
  }
  get lr() { return this.lr0 / (1 + this.trained / this.tau); }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && j.w) {
        this.w = { ...this.w, ...j.w };
        this.b = j.b || 0;
        this.trained = j.trained || 0;
        this.lossModel = j.lossModel || [];
        this.lossMarket = j.lossMarket || [];
      }
    } catch { /* first run */ }
  }
  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({
        w: this.w, b: this.b, trained: this.trained,
        lossModel: this.lossModel.slice(-3000), lossMarket: this.lossMarket.slice(-3000),
      }, null, 2));
    } catch { /* best effort */ }
  }

  /** P(Up), built as an adjustment to the market's own probability. */
  prob(f, mktProb) {
    let adj = this.b;
    for (const k of FEATURE_KEYS) adj += (this.w[k] || 0) * (f[k] || 0);
    const p = sigmoid(logit(mktProb) + adj);
    this.recent.push(p - mktProb);     // track DISAGREEMENT, not level
    if (this.recent.length > 300) this.recent.shift();
    return p;
  }

  /**
   * Has it learned to disagree with the market in a varied, information-bearing
   * way? A model whose disagreement is always the same number has found a
   * constant bias, not a signal.
   */
  isInformative() {
    if (this.recent.length < 40) return false;
    const n = this.recent.length;
    const mean = this.recent.reduce((a, x) => a + x, 0) / n;
    const sd = Math.sqrt(this.recent.reduce((a, x) => a + (x - mean) ** 2, 0) / n);
    return sd >= MIN_PROB_SPREAD;
  }

  /** One step, after the round has settled. y is 1 for Up. */
  train(f, mktProb, y) {
    const p = this.prob(f, mktProb);
    const err = p - y;
    const lr = this.lr;
    for (const k of FEATURE_KEYS) {
      this.w[k] -= lr * (err * (f[k] || 0) + this.l2 * this.w[k]);
    }
    this.b -= lr * err;
    this.trained++;
    // Gate 1's raw material: how badly each of us predicted this round.
    const ll = (q) => -(y * Math.log(clip(q, 1e-6, 1 - 1e-6)) + (1 - y) * Math.log(clip(1 - q, 1e-6, 1 - 1e-6)));
    this.lossModel.push(ll(p));
    this.lossMarket.push(ll(mktProb));
    if (this.lossModel.length > 3000) { this.lossModel.shift(); this.lossMarket.shift(); }
  }

  /**
   * Gate 1. Lower log loss is a better predictor. Positive edge means the model
   * is beating the market's own prices. This is the number that decides whether
   * any of this works.
   */
  benchmark(window = 3000) {
    const m = this.lossModel.slice(-window);
    const k = this.lossMarket.slice(-window);
    const n = Math.min(m.length, k.length);
    if (n < 30) return { n, ready: false };
    const avg = (a) => a.slice(-n).reduce((x, y) => x + y, 0) / n;
    const lm = avg(m), lk = avg(k);
    const diffs = [];
    for (let i = 0; i < n; i++) diffs.push(k[k.length - n + i] - m[m.length - n + i]);
    const mean = diffs.reduce((a, x) => a + x, 0) / n;
    const sd = Math.sqrt(diffs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
    const stderr = sd / Math.sqrt(n);
    return {
      n, ready: true, lossModel: lm, lossMarket: lk, edge: mean, stderr,
      beatsMarket: mean > 3 * stderr,
      verdict: n < 200 ? 'too few' : mean > 3 * stderr ? 'BEATS MARKET' : mean < -3 * stderr ? 'worse than market' : 'no better than market',
    };
  }
}

/** Calibration: when it says 70%, does it win 70%? */
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
    out.push({ lo, hi, n: inBand.length, claimed: (lo + hi) / 2, actual: wins / inBand.length });
  }
  return out;
}

const STRATEGIES = {
  always_up:   () => 'UP',
  always_down: () => 'DOWN',
  follow_book: (f, m) => (m > 0.5 ? 'UP' : 'DOWN'),
  fade_book:   (f, m) => (m > 0.5 ? 'DOWN' : 'UP'),
  momentum:    (f) => (f.moveZ === 0 ? null : f.moveZ > 0 ? 'UP' : 'DOWN'),
  fade_move:   (f) => (f.moveZ === 0 ? null : f.moveZ > 0 ? 'DOWN' : 'UP'),
};

const entryPrice = (snap, side) =>
  side === 'UP' ? (num(snap.yesQuote) ?? num(snap.yesPrice)) : (num(snap.noQuote) ?? num(snap.noPrice));

const takerFeePerShare = (p, coef) => (!coef || !Number.isFinite(p) ? 0 : coef * p * (1 - p));
const breakevenWinRate = (p, coef) => p + takerFeePerShare(p, coef);

/** Build every paper bet for one round, at entry time. */
function makePredictions(snap, vol, model, stake) {
  const f = features(snap, vol);
  const mkt = marketProb(snap);
  const coef = num(snap.feeCoefficient) ?? 0.0695;
  const out = [];

  const add = (strategy, side, extra = {}) => {
    const px = entryPrice(snap, side);
    if (px == null || px <= 0.005 || px >= 0.995) return;
    const fee = takerFeePerShare(px, coef);
    const shares = stake / (px + fee);           // spend exactly `stake` dollars
    out.push({ strategy, side, price: px, fee, shares, stake, ...extra });
  };

  for (const [name, fn] of Object.entries(STRATEGIES)) {
    const side = fn(f, mkt);
    if (side) add(name, side);
  }

  const pUp = model.prob(f, mkt);
  add('model_direction', pUp >= 0.5 ? 'UP' : 'DOWN', { modelProb: pUp, marketProb: mkt });

  // Edge-aware, gated on the model having earned the right to bet.
  if (model.trained >= MIN_TRAINED && model.isInformative()) {
    for (const side of ['UP', 'DOWN']) {
      const px = entryPrice(snap, side);
      if (px == null || px <= 0.005 || px >= 0.995) continue;
      const need = breakevenWinRate(px, coef);
      const mine = side === 'UP' ? pUp : 1 - pUp;
      if (mine > need + EDGE_MARGIN) {
        add('model_edge', side, { modelProb: mine, required: need, marketProb: mkt });
        break;
      }
    }
  }

  return { features: f, marketProb: mkt, modelProb: pUp, predictions: out };
}

/** Score one bet. P&L is in dollars. */
function score(pred, resolvedUp) {
  const won = (pred.side === 'UP') === (resolvedUp === 1);
  const shares = pred.shares ?? 1;
  const stake = pred.stake ?? (pred.price + pred.fee);
  return { won, pnl: (won ? shares : 0) - stake };
}

function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.strategy)) by.set(r.strategy, []);
    by.get(r.strategy).push(r);
  }
  const out = [];
  for (const [name, list] of by) {
    const n = list.length;
    if (!n) continue;
    const wins = list.filter((x) => x.won).length;
    const pnl = list.reduce((a, x) => a + x.pnl, 0);
    const staked = list.reduce((a, x) => a + (x.stake ?? 0), 0);
    const need = list.reduce((a, x) => a + x.price + x.fee, 0) / n;
    const mean = pnl / n;
    const sd = Math.sqrt(list.reduce((a, x) => a + (x.pnl - mean) ** 2, 0) / Math.max(1, n - 1));
    const stderr = sd / Math.sqrt(n);
    out.push({
      strategy: name, n, wins, winRate: wins / n, breakeven: need,
      pnl, pnlPerBet: mean, staked, roi: staked ? pnl / staked : 0, stderr,
      // Three standard errors, not two: with 8 strategies in view a 2-sigma
      // rule calls pure coinflips profitable about 4% of the time.
      verdict: n < 100 ? 'too few' : Math.abs(mean) <= 3 * stderr ? 'noise' : mean > 0 ? 'POSITIVE' : 'negative',
    });
  }
  return out.sort((a, b) => b.pnlPerBet - a.pnlPerBet);
}

module.exports = {
  features, FEATURE_KEYS, LABEL, Model, STRATEGIES, entryPrice, makePredictions,
  score, summarize, sigmoid, logit, clip, marketProb, spreadWidth, calibration,
  takerFeePerShare, breakevenWinRate, num,
  MIN_TRAINED, EDGE_MARGIN, MIN_PROB_SPREAD,
};
