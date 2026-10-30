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
    let wait = 400 * (i + 1);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (res.status === 429) wait = 1000 * 2 ** i;      // documented: back off, at least 1s
      if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
      return await res.json();
    } catch (e) {
      lastErr = e;
      // 404 means "no such round", not a transient failure. Don't retry it.
      if (e.status === 404) break;
      if (i < retries) await new Promise((r) => setTimeout(r, wait));
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
  // Only trust a result once the exchange has published a settlement price,
  // or marked the market resolved. In the seconds after the close the event
  // can show a placeholder outcome; v1 accepted that and logged 73 of its
  // first 365 rounds as Down when they settled Up.
  let resolvedUp = null;
  const isResolved = /RESOLVED|SETTLED/i.test(mk.status || '');
  if (settlement != null && priceToBeat != null) resolvedUp = settlement >= priceToBeat ? 1 : 0;
  else if (isResolved && prices.length === 2 && (prices[0] === '1' || prices[0] === '0')) resolvedUp = Number(prices[0]);

  return {
    horizon: mins,
    slug: ev.slug,
    marketSlug: mk.slug || (ev.slug ? 'cpc-' + ev.slug : null),
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
  return fetchEvent(slugFor(date, mins));
}

/** Horizon and round boundaries, read straight off a slug. */
function parseSlug(slug) {
  const m = /^btc-updown-(\d+)m-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})z$/.exec(slug || '');
  if (!m) return null;
  const mins = Number(m[1]);
  const start = Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5], +m[6]);
  return { horizon: mins, startMs: start, endMs: start + mins * 60000 };
}

/** One round by its event slug. Works for live rounds and for ~4 weeks of past ones. */
async function fetchEvent(slug) {
  const p = parseSlug(slug);
  const j = await getJSON(`${GATEWAY}/v1/events?slug=${encodeURIComponent(slug)}`);
  return shape(j?.events?.[0], p ? p.horizon : null);
}

/**
 * Full order book for one market (documented: GET /v1/markets/{slug}/book,
 * keyed by the MARKET slug, "cpc-btc-updown-..."). Bids and offers are on the
 * Yes side. Buying No at q is selling Yes at 1 - q, so No fills walk the bids.
 */
async function fetchBook(marketSlug) {
  const j = await getJSON(`${GATEWAY}/v1/markets/${encodeURIComponent(marketSlug)}/book`, { retries: 1, timeoutMs: 6000 });
  const lv = (a) => (a || []).map((x) => ({ px: num(x?.px?.value), qty: num(x?.qty) }))
    .filter((x) => x.px != null && x.qty != null && x.qty > 0);
  const d = j?.marketData || {};
  return {
    bids: lv(d.bids).sort((a, b) => b.px - a.px),       // best (highest) first
    offers: lv(d.offers).sort((a, b) => a.px - b.px),   // best (lowest) first
  };
}

/**
 * Book-derived Yes/No display prices for one market, oldest first.
 * longPrice is the Yes ask; shortPrice is the No ask (1 - Yes bid). Documented.
 */
async function fetchPriceHistory(marketSlug, startSec, endSec) {
  const u = `${GATEWAY}/v1/price-history?symbol=${encodeURIComponent(marketSlug)}`
    + `&timestamp.startTimestamp=${startSec}&timestamp.endTimestamp=${endSec}&fidelity=1`;
  const j = await getJSON(u, { retries: 3 });
  return (j?.history || []).map((h) => ({ t: Number(h.timestamp), yesAsk: num(h.longPrice), noAsk: num(h.shortPrice) }))
    .filter((h) => Number.isFinite(h.t)).sort((a, b) => a.t - b.t);
}

/**
 * BRTI, the index these rounds settle on, as OHLC candles. 1-second buckets
 * cover up to an hour per request. Returned as { t (unix s), v (close) }.
 */
async function fetchBrti(fromSec, toSec = 0, bucket = '1S') {
  const u = `${GATEWAY}/v1/asset-prices/history?assets=crypto:btc&from=${fromSec}&to=${toSec}&bucket=ASSET_PRICE_BUCKET_${bucket}`;
  const j = await getJSON(u, { retries: 2, timeoutMs: 8000 });
  const s = (j?.series || []).find((x) => x?.asset?.symbol === 'btc');
  return (s?.candles || []).map((c) => ({
    t: Number(c.timestamp), v: num(c.close), o: num(c.open), h: num(c.high), l: num(c.low), n: Number(c.tickCount) || 0,
  })).filter((c) => Number.isFinite(c.t) && c.v != null);
}

/**
 * Polymarket US taker fee, per share:  fee = coefficient * p * (1 - p)
 * Peaks at p = 0.50. Makers are not charged (tier 1 makers get no rebate
 * either). Confirmed against the official fee schedule, docs.polymarket.us/fees.
 * Read the coefficient off the live market rather than hardcoding it.
 */
function takerFeePerShare(p, coefficient) {
  if (!coefficient || !Number.isFinite(p)) return 0;
  return coefficient * p * (1 - p);
}

/** Win rate required just to break even buying at price p. */
const breakevenWinRate = (p, coef) => p + takerFeePerShare(p, coef);

module.exports = {
  GATEWAY, getJSON, roundStart, slugFor, parseSlug, shape, fetchRound, fetchEvent,
  fetchBook, fetchPriceHistory, fetchBrti,
  takerFeePerShare, breakevenWinRate, num,
};
