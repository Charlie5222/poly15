'use strict';
/**
 * probe2-us.js — second pass. We know /v1/markets works and the schema.
 * Now: are there short-duration BTC up/down markets, what is the fee, and
 * where is the order book? Read-only, no key, no orders.
 */
const fs = require('fs');
const path = require('path');
const HOST = 'https://gateway.polymarket.us';
const OUT = path.join(__dirname, 'probe2-us.json');

async function get(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, raw: json ? null : text.slice(0, 300) };
  } catch (e) { return { ok: false, status: 0, error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

const isBtcUpDown = (m) => {
  const s = `${m.question || ''} ${m.slug || ''}`.toLowerCase();
  return /btc|bitcoin/.test(s) && /up|down/.test(s);
};
const slim = (m) => ({
  id: m.id, slug: m.slug, question: m.question, category: m.category,
  marketType: m.marketType, active: m.active, closed: m.closed, status: m.status,
  startDate: m.startDate, endDate: m.endDate,
  outcomes: m.outcomes, outcomePrices: m.outcomePrices,
  feeCoefficient: m.feeCoefficient, orderPriceMinTickSize: m.orderPriceMinTickSize,
  minimumTradeQty: m.minimumTradeQty,
  marketSideIds: Array.isArray(m.marketSides) ? m.marketSides.map((s) => s.id) : null,
  marketSideIdentifiers: Array.isArray(m.marketSides) ? m.marketSides.map((s) => s.identifier) : null,
});

(async () => {
  const report = { host: HOST, probedAt: new Date().toISOString(), tries: {} };

  // 1) Filter attempts — we do not know which query params the gateway honors.
  const filters = [
    '/v1/markets?limit=100&category=crypto',
    '/v1/markets?limit=100&active=true',
    '/v1/markets?limit=100&closed=false',
    '/v1/markets?limit=100&search=bitcoin',
    '/v1/markets?limit=100&q=bitcoin',
    '/v1/markets?limit=100&slug=btc-updown-15m',
    '/v1/markets?limit=200&offset=0',
  ];
  const categories = new Set();
  const btcFound = [];

  for (const f of filters) {
    const r = await get(HOST + f);
    const list = r.json?.markets || [];
    const hits = list.filter(isBtcUpDown);
    for (const m of list) if (m.category) categories.add(m.category);
    report.tries[f] = {
      status: r.status, returned: list.length, btcHits: hits.length,
      error: r.error, firstQuestions: list.slice(0, 3).map((m) => m.question),
    };
    for (const m of hits) if (!btcFound.find((x) => x.id === m.id)) btcFound.push(m);
    process.stdout.write(`${f} -> ${r.status} n=${list.length} btc=${hits.length}\n`);
  }

  // 2) Page through more broadly if nothing yet.
  if (!btcFound.length) {
    process.stdout.write('paging for BTC markets...\n');
    for (let off = 0; off < 2000; off += 200) {
      const r = await get(`${HOST}/v1/markets?limit=200&offset=${off}`);
      const list = r.json?.markets || [];
      if (!list.length) break;
      for (const m of list) if (m.category) categories.add(m.category);
      const hits = list.filter(isBtcUpDown);
      for (const m of hits) if (!btcFound.find((x) => x.id === m.id)) btcFound.push(m);
      process.stdout.write(`  offset=${off} n=${list.length} btc_total=${btcFound.length}\n`);
      if (btcFound.length >= 5 || list.length < 200) break;
    }
  }

  report.categoriesSeen = [...categories].sort();
  report.btcUpDownFound = btcFound.length;
  report.btcSamples = btcFound.slice(0, 5).map(slim);

  // 3) If we have one, find its order book endpoint.
  if (btcFound.length) {
    const m = btcFound[0];
    const sideId = Array.isArray(m.marketSides) && m.marketSides[0] ? m.marketSides[0].id : null;
    const cands = [
      `/v1/markets/${m.id}`,
      `/v1/markets/${m.slug}`,
      `/v1/orderbook?marketId=${m.id}`,
      `/v1/orderbook/${m.id}`,
      `/v1/book?marketId=${m.id}`,
      `/v1/markets/${m.id}/orderbook`,
      `/v1/markets/${m.id}/book`,
      sideId ? `/v1/orderbook?marketSideId=${sideId}` : null,
      sideId ? `/v1/orderbook/${sideId}` : null,
      sideId ? `/v1/markets/${m.id}/sides/${sideId}/orderbook` : null,
    ].filter(Boolean);
    report.orderbookTries = {};
    for (const c of cands) {
      const r = await get(HOST + c);
      report.orderbookTries[c] = {
        status: r.status, ok: r.ok,
        keys: r.json && typeof r.json === 'object' ? Object.keys(r.json).slice(0, 20) : null,
        sample: r.json ? JSON.stringify(r.json).slice(0, 700) : r.raw,
      };
      process.stdout.write(`  book ${c} -> ${r.status}\n`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log(`categories seen: ${report.categoriesSeen.join(', ') || '(none)'}`);
  console.log(`BTC up/down markets found: ${report.btcUpDownFound}`);
})();
