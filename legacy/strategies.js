'use strict';
// Shared evaluation core. Used by both the CLI (analyze.js) and the app server.

const fs = require('fs');
const path = require('path');
const { takerFeePerShare, dataDir } = require('./lib');

const DATA = dataDir();

function readJSONL(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const loadSnapshots = () => readJSONL(path.join(DATA, 'snapshots.jsonl'));
const loadRounds = () => readJSONL(path.join(DATA, 'rounds.jsonl'));

// Join each resolved round to the snapshot nearest the chosen entry time.
function buildSamples(entrySecs = 60) {
  const snaps = loadSnapshots();
  const rounds = loadRounds();
  const byRound = new Map();
  for (const s of snaps) {
    if (s.secsToClose == null || s.secsToClose < 0) continue;
    const cur = byRound.get(s.slug);
    if (!cur || Math.abs(s.secsToClose - entrySecs) < Math.abs(cur.secsToClose - entrySecs)) {
      byRound.set(s.slug, s);
    }
  }
  const samples = [];
  for (const r of rounds) {
    const s = byRound.get(r.slug);
    if (!s) continue;
    const upAsk = s.up?.bestAsk, upBid = s.up?.bestBid;
    if (upAsk == null || upBid == null) continue;
    samples.push({
      slug: r.slug,
      resolvedUp: r.resolvedUp,
      secsToClose: s.secsToClose,
      upAsk, upBid,
      dnAsk: s.down?.bestAsk, dnBid: s.down?.bestBid,
      upMid: (upAsk + upBid) / 2,
      spotVsOpen: s.spotVsOpen,
      feeSchedule: r.feeSchedule || s.feeSchedule || null,
    });
  }
  return { samples, totalRounds: rounds.length, totalSnaps: snaps.length };
}

const STRATEGIES = {
  always_up:      () => 'UP',
  always_down:    () => 'DOWN',
  momentum:       (s) => (s.spotVsOpen == null ? null : s.spotVsOpen > 0 ? 'UP' : 'DOWN'),
  fade:           (s) => (s.spotVsOpen == null ? null : s.spotVsOpen > 0 ? 'DOWN' : 'UP'),
  follow_book:    (s) => (s.upMid > 0.5 ? 'UP' : 'DOWN'),
  fade_book:      (s) => (s.upMid > 0.5 ? 'DOWN' : 'UP'),
  momentum_tight: (s) => {
    if (s.spotVsOpen == null) return null;
    if (Math.abs(s.spotVsOpen) < 15) return null;
    if (s.upMid < 0.35 || s.upMid > 0.65) return null;
    return s.spotVsOpen > 0 ? 'UP' : 'DOWN';
  },
};

function tradePnL(smp, side, maker) {
  const ask = side === 'UP' ? smp.upAsk : smp.dnAsk;
  const bid = side === 'UP' ? smp.upBid : smp.dnBid;
  const price = maker ? bid : ask;
  if (price == null || price <= 0 || price >= 1) return null;
  const fee = maker ? 0 : takerFeePerShare(price, smp.feeSchedule);
  const won = side === 'UP' ? smp.resolvedUp === 1 : smp.resolvedUp === 0;
  return { price, fee, pnl: (won ? 1 : 0) - price - fee, won };
}

function evaluate(samples, name, pick, maker, minRounds) {
  const trades = [];
  for (const s of samples) {
    const side = pick(s);
    if (!side) continue;
    const t = tradePnL(s, side, maker);
    if (t) trades.push(t);
  }
  if (!trades.length) return null;
  const n = trades.length;
  const wins = trades.filter((t) => t.won).length;
  const total = trades.reduce((a, t) => a + t.pnl, 0);
  const staked = trades.reduce((a, t) => a + t.price + t.fee, 0);
  const mean = total / n;
  const sd = Math.sqrt(trades.reduce((a, t) => a + (t.pnl - mean) ** 2, 0) / Math.max(1, n - 1));
  const stderr = sd / Math.sqrt(n);
  const significant = Math.abs(mean) > 2 * stderr;
  return {
    name, n, wins, winRate: wins / n,
    avgPrice: trades.reduce((a, t) => a + t.price, 0) / n,
    avgFee: trades.reduce((a, t) => a + t.fee, 0) / n,
    pnlPerShare: mean,
    roi: staked > 0 ? total / staked : 0,
    stderr,
    verdict: n < minRounds ? 'too few' : !significant ? 'noise' : mean > 0 ? 'POSITIVE' : 'negative',
  };
}

function runAll(samples, { maker = false, minRounds = 20 } = {}) {
  return Object.entries(STRATEGIES)
    .map(([k, f]) => evaluate(samples, k, f, maker, minRounds))
    .filter(Boolean)
    .sort((a, z) => z.pnlPerShare - a.pnlPerShare);
}

module.exports = {
  DATA, readJSONL, loadSnapshots, loadRounds, buildSamples,
  STRATEGIES, runAll, evaluate, takerFeePerShare,
};
