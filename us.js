'use strict';
/**
 * us.js — Polymarket US adapter.
 *
 * Public market data only: gateway.polymarket.us needs no key and exposes no
 * account. Nothing here can place an order.
 *
 * Round slugs are deterministic:   btc-updown-<15m|5m>-YYYY-MM-DD-HHMMz  (UTC)
 * Everything we need rides along on the event:
 *   assetPriceTerms.priceToBeat     price at the round's open (BRTI index)
 *   assetPriceTerms.windowStart/End exact round boundaries
 *   assetPriceTerms.settlementPrice fills in once the round resolves
 *   market.bestBidQuote/bestAskQuote top of book
 *   market.feeCoefficient           the live taker fee coefficient
 */

const GATEWAY = 'https://gateway.polymarket.us';

async function getJSON(url, { timeoutMs = 10000, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}

/** Round start containing `date`, floored to the horizon. */
function roundStart(date, mins) {
  const ms = mins * 60 * 1000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

function slugFor(date, mins) {
  const t = roundStart(date, mins);
  const p = (n) => String(n).padStart(2, '0');
  return `btc-updown-${mins}m-${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}-${p(t.getUTCHours())}${p(t.getUTCMinutes())}z`;
}

// Number(null) and Number('') are both 0, which would silently turn a missing
// settlement price into a resolved "DOWN". Reject empties explicitly.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function parseMaybeJSON(v, fb) {
  if (v == null) return fb;
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return fb; }
}

/** Flatten one event into the fields we record. */
function shape(ev, mins) {
  if (!ev) return null;
  const mk = ev.markets?.[0];
  if (!mk) return null;
  const terms = mk.assetPriceTerms || {};
  const sides = mk.marketSides || [];
  const yes = sides.find((s) => /^yes$/i.test(s.description || '')) || sides.find((s) => s.long);
  const no  = sides.find((s) => /^no$/i.test(s.description || ''))  || sides.find((s) => s.long === false);
  const prices = parseMaybeJSON(mk.outcomePrices, []);

  const priceToBeat = num(terms.priceToBeat?.value);
  const settlement  = num(terms.settlementPrice?.value ?? terms.settlementPrice);

  // Resolution: Up wins when the settling index is at or above the open.
  let resolvedUp = null;
  if (settlement != null && priceToBeat != null) resolvedUp = settlement >= priceToBeat ? 1 : 0;
  else if (prices.length === 2 && (prices[0] === '1' || prices[0] === '0')) resolvedUp = Number(prices[0]);

  return {
    horizon: mins,
    slug: ev.slug,
    eventId: ev.id,
    marketId: mk.id,
    title: ev.title,
    windowStart: terms.windowStart || ev.startDate || null,
    windowEnd: terms.windowEnd || ev.endDate || null,
    status: mk.status || null,
    live: !!ev.live,
    ended: !!ev.ended,
    closed: !!(ev.closed || mk.closed),
    tradable: !!(yes?.tradable),
    indexSymbol: terms.indexSymbol || null,     // BRTI
    priceToBeat,
    settlementPrice: settlement,
    resolvedUp,
    // Top of book plus both sides. We record every price field verbatim rather
    // than assuming which is bid and which is ask.
    bestBidQuote: num(mk.bestBidQuote?.value ?? mk.bestBidQuote),
    bestAskQuote: num(mk.bestAskQuote?.value ?? mk.bestAskQuote),
    yesPrice: num(yes?.price),
    yesQuote: num(yes?.quote?.value),
    noPrice: num(no?.price),
    noQuote: num(no?.quote?.value),
    outcomePrices: prices,
    feeCoefficient: num(mk.feeCoefficient),
    tickSize: num(mk.orderPriceMinTickSize),
    minQty: num(mk.minimumTradeQty),
  };
}

async function fetchRound(date, mins) {
  const slug = slugFor(date, mins);
  const j = await getJSON(`${GATEWAY}/v1/events?slug=${encodeURIComponent(slug)}`);
  const ev = j?.events?.[0];
  return shape(ev, mins);
}

/**
 * Polymarket US taker fee, per share:  fee = coefficient * p * (1 - p)
 * Peaks at p = 0.50. Makers are not charged. Read the coefficient off the live
 * market rather than hardcoding it.
 */
function takerFeePerShare(p, coefficient) {
  if (!coefficient || !Number.isFinite(p)) return 0;
  return coefficient * p * (1 - p);
}

/** Win rate required just to break even buying at price p. */
const breakevenWinRate = (p, coef) => p + takerFeePerShare(p, coef);

module.exports = {
  GATEWAY, getJSON, roundStart, slugFor, shape, fetchRound,
  takerFeePerShare, breakevenWinRate, num,
};
