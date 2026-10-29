'use strict';
/**
 * probe5-us.js — Bitcoin exists on Polymarket US. Now get the live 15m board
 * and its order book. Read-only. No key, no account, no orders.
 */
const fs = require('fs');
const path = require('path');
const H = 'https://gateway.polymarket.us';
const OUT = path.join(__dirname, 'probe5-us.json');

async function get(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, json, raw: json ? null : text.slice(0, 200) };
  } catch (e) { return { status: 0, ok: false, error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

(async () => {
  const report = { probedAt: new Date().toISOString() };

  // 1) Every bitcoin-related tag.
  const tags = (await get(`${H}/v1/tags`)).json?.tags || [];
  const btcTags = tags.filter((t) => /bitcoin|btc/i.test(`${t.slug} ${t.label}`));
  report.btcTags = btcTags;
  console.log(`bitcoin tags (${btcTags.length}):`);
  for (const t of btcTags) console.log(`   id=${t.id} slug=${t.slug} label="${t.label}" parent=${t.parentId}`);

  // 2) Search, and events filtered by the bitcoin series / tags.
  const tries = [
    `/v1/search?q=bitcoin`,
    `/v1/events?seriesId=101&limit=20`,
    `/v1/events?series=btc&limit=20`,
    `/v1/events?seriesSlug=btc&limit=20`,
    `/v1/events?limit=20`,
  ];
  for (const t of btcTags.slice(0, 8)) {
    tries.push(`/v1/events?tagId=${t.id}&limit=20`);
    tries.push(`/v1/events?tag=${t.slug}&limit=20`);
  }

  report.eventTries = {};
  let liveEvents = [];
  for (const t of tries) {
    const r = await get(H + t);
    const evs = r.json?.events || [];
    const btc = evs.filter((e) => /bitcoin|btc/i.test(`${e.title || ''} ${e.slug || ''}`));
    report.eventTries[t] = {
      status: r.status, returned: evs.length, btcCount: btc.length,
      titles: evs.slice(0, 4).map((e) => e.title || e.slug),
    };
    console.log(`${r.status}  ${t}  n=${evs.length} btc=${btc.length}`);
    for (const e of btc) if (!liveEvents.find((x) => x.id === e.id)) liveEvents.push(e);
  }

  report.btcEventCount = liveEvents.length;
  report.btcEvents = liveEvents.slice(0, 10).map((e) => ({
    id: e.id, slug: e.slug, title: e.title,
    startDate: e.startDate, endDate: e.endDate,
    active: e.active, closed: e.closed,
    marketCount: Array.isArray(e.markets) ? e.markets.length : null,
    firstMarket: Array.isArray(e.markets) && e.markets[0]
      ? Object.fromEntries(Object.entries(e.markets[0]).filter(([, v]) => typeof v !== 'object').slice(0, 30))
      : null,
  }));

  // 3) For the first live market, locate the order book.
  const ev = liveEvents[0];
  const mk = ev && Array.isArray(ev.markets) ? ev.markets[0] : null;
  if (mk) {
    report.marketShape = Object.keys(mk);
    const sideIds = Array.isArray(mk.marketSides) ? mk.marketSides.map((s) => s.id) : [];
    report.marketSides = Array.isArray(mk.marketSides)
      ? mk.marketSides.map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v !== 'object').slice(0, 15)))
      : null;
    const cands = [
      `/v1/markets/${mk.id}/orderbook`, `/v1/orderbook?marketId=${mk.id}`,
      `/v1/orderbook/${mk.id}`, `/v1/markets/${mk.slug}/orderbook`,
      `/v1/books?marketId=${mk.id}`, `/v1/depth?marketId=${mk.id}`,
      ...sideIds.flatMap((s) => [`/v1/orderbook?marketSideId=${s}`, `/v1/orderbook/${s}`,
                                 `/v1/marketSides/${s}/orderbook`]),
    ];
    report.bookTries = {};
    console.log(`\nlocating order book for market ${mk.id} (${mk.slug}):`);
    for (const c of cands) {
      const r = await get(H + c);
      report.bookTries[c] = { status: r.status, sample: r.json ? JSON.stringify(r.json).slice(0, 500) : r.raw };
      console.log(`   ${r.status}  ${c}`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nBTC events found: ${liveEvents.length}`);
  console.log(`Wrote ${OUT}`);
})();
