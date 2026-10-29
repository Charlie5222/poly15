'use strict';
// Shared helpers. No dependencies, no credentials, read-only HTTP.

const os = require('os');
const pathmod = require('path');

// Where recordings live. The .app launcher points this at Application Support
// so that rebuilding the app never destroys collected data.
function dataDir() {
  if (process.env.POLY15_DATA) return process.env.POLY15_DATA;
  return pathmod.join(__dirname, 'data');
}

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const ROUND_SECS = 900; // 15 minutes

async function getJSON(url, { timeoutMs = 10000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Round start epoch (seconds) containing time `tMs`, aligned to 15 minutes.
function roundStart(tMs = Date.now()) {
  return Math.floor(tMs / 1000 / ROUND_SECS) * ROUND_SECS;
}

const slugFor = (startEpoch) => `btc-updown-15m-${startEpoch}`;

// Gamma sometimes encodes array fields as JSON strings.
function parseMaybeJSON(v, fallback) {
  if (v == null) return fallback;
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// Look up one round's event. Primary: slug filter. Fallback: public-search.
async function fetchEventBySlug(slug) {
  try {
    const arr = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(slug)}&limit=1`);
    const ev = Array.isArray(arr) ? arr[0] : (arr?.events?.[0] ?? arr?.data?.[0]);
    if (ev) return ev;
  } catch { /* fall through */ }
  const r = await getJSON(`${GAMMA}/public-search?q=${encodeURIComponent(slug)}`);
  return (r.events || []).find((e) => e.slug === slug) || null;
}

// Flatten the bits we care about out of a Gamma event.
function shapeRound(ev) {
  if (!ev) return null;
  const m = (ev.markets || [])[0];
  if (!m) return null;
  const tokens   = parseMaybeJSON(m.clobTokenIds, []);
  const outcomes = parseMaybeJSON(m.outcomes, []);
  const prices   = parseMaybeJSON(m.outcomePrices, []);
  const meta     = ev.eventMetadata || {};
  return {
    slug: ev.slug,
    title: ev.title,
    conditionId: m.conditionId,
    upTokenId: tokens[0] ?? null,     // outcomes[0] === "Up"
    downTokenId: tokens[1] ?? null,
    outcomes,
    startTime: ev.startTime || m.eventStartTime || null,
    endDate: m.endDate || ev.endDate || null,
    closed: !!(ev.closed || m.closed),
    acceptingOrders: !!m.acceptingOrders,
    minTick: m.orderPriceMinTickSize ?? 0.001,
    minSize: m.orderMinSize ?? 5,
    feeType: m.feeType ?? null,
    // Authoritative fee params straight from the market. Do not hardcode these:
    // Polymarket has shipped more than one schedule for these markets.
    feeSchedule: m.feeSchedule ?? null,
    priceToBeat: meta.priceToBeat ?? null,   // Chainlink BTC/USD at round open
    finalPrice: meta.finalPrice ?? null,     // populated after resolution
    // Resolved label: 1 => Up won, 0 => Down won, null => not resolved yet
    resolvedUp: prices.length === 2 && (prices[0] === '1' || prices[0] === '0')
      ? Number(prices[0]) : null,
  };
}

async function fetchBook(tokenId) {
  const b = await getJSON(`${CLOB}/book?token_id=${tokenId}`);
  // CLOB returns bids ascending and asks descending; sort defensively.
  const bids = (b.bids || []).map((o) => ({ p: +o.price, s: +o.size })).sort((a, z) => z.p - a.p);
  const asks = (b.asks || []).map((o) => ({ p: +o.price, s: +o.size })).sort((a, z) => a.p - z.p);
  return {
    bestBid: bids[0]?.p ?? null,
    bestBidSize: bids[0]?.s ?? null,
    bestAsk: asks[0]?.p ?? null,
    bestAskSize: asks[0]?.s ?? null,
    bidDepth5: bids.slice(0, 5).reduce((t, o) => t + o.s, 0),
    askDepth5: asks.slice(0, 5).reduce((t, o) => t + o.s, 0),
  };
}

// Free, no-key spot reference. NOTE: resolution uses the Chainlink BTC/USD
// stream, not Coinbase. Treat this as a proxy with its own basis and lag.
async function fetchSpot() {
  const j = await getJSON('https://api.coinbase.com/v2/prices/BTC-USD/spot');
  return Number(j?.data?.amount) || null;
}

/**
 * Polymarket taker fee, per share.
 *   fee = rate * (p * (1 - p)) ** exponent
 * With the crypto_15_min schedule (rate 0.25, exponent 2) that peaks at
 * 0.015625/share at p=0.50. With crypto_fees_v2 (rate 0.07, exponent 1) it
 * peaks at 0.0175/share. Makers pay zero. Always read the live schedule off
 * the market rather than trusting these numbers.
 */
function takerFeePerShare(p, feeSchedule) {
  if (!feeSchedule) return 0;
  const { rate = 0, exponent = 1 } = feeSchedule;
  const u = p * (1 - p);
  return rate * Math.pow(u, exponent);
}

module.exports = {
  dataDir, GAMMA, CLOB, ROUND_SECS, getJSON, sleep, roundStart, slugFor,
  fetchEventBySlug, shapeRound, fetchBook, fetchSpot, takerFeePerShare, parseMaybeJSON,
};
