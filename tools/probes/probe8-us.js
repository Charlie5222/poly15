'use strict';
/** probe8-us.js — dump one live BTC round in full, and look harder for prices.
 *  Read-only. No key, no account, no orders. */
const fs = require('fs'); const path = require('path');
const H = 'https://gateway.polymarket.us';
const OUT = path.join(__dirname, 'probe8-us.json');

async function get(u, ms = 12000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: 'application/json' } });
        const x = await r.text(); let j = null; try { j = JSON.parse(x); } catch {}
        return { status: r.status, json: j, raw: j ? null : x.slice(0, 300) }; }
  catch (e) { return { status: 0, error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}
function slugFor(date, mins) {
  const ms = mins * 60 * 1000;
  const t = new Date(Math.floor(date.getTime() / ms) * ms);
  const p = (n) => String(n).padStart(2, '0');
  return `btc-updown-${mins}m-${t.getUTCFullYear()}-${p(t.getUTCMonth()+1)}-${p(t.getUTCDate())}-${p(t.getUTCHours())}${p(t.getUTCMinutes())}z`;
}

(async () => {
  const rep = { probedAt: new Date().toISOString() };
  const now = new Date();
  const s15 = slugFor(now, 15);
  const r = await get(`${H}/v1/events?slug=${s15}`);
  const ev = r.json?.events?.[0];
  rep.slug = s15;
  rep.fullEvent = ev || null;            // everything, nested included
  console.log(`event ${s15}: ${ev ? 'found' : 'MISSING'}`);
  if (ev) {
    const mk = ev.markets?.[0];
    console.log('event keys :', Object.keys(ev).join(', '));
    if (mk) {
      console.log('market keys:', Object.keys(mk).join(', '));
      console.log('side keys  :', mk.marketSides?.[0] ? Object.keys(mk.marketSides[0]).join(', ') : '(none)');
      console.log(`\nevent.startDate=${ev.startDate} endDate=${ev.endDate}`);
      console.log(`market.startDate=${mk.startDate} endDate=${mk.endDate} gameStartTime=${mk.gameStartTime}`);
      console.log(`status=${mk.status} ep3Status=${mk.ep3Status} prices=${mk.outcomePrices}`);

      // Hunt for quotes/trades/book under other shapes.
      const sideIds = (mk.marketSides || []).map((x) => x.id);
      const cands = [
        `/v1/markets/${mk.id}/trades`, `/v1/trades?marketId=${mk.id}`,
        `/v1/markets/${mk.id}/prices`, `/v1/prices?marketId=${mk.id}`,
        `/v1/markets/${mk.id}/history`, `/v1/priceHistory?marketId=${mk.id}`,
        `/v1/markets/${mk.id}`, `/v1/events/${ev.id}`,
        ...sideIds.flatMap((x) => [
          `/v1/marketSides/${x}`, `/v1/prices?marketSideId=${x}`,
          `/v1/trades?marketSideId=${x}`, `/v1/priceHistory?marketSideId=${x}`,
          `/v1/marketSides/${x}/prices`, `/v1/marketSides/${x}/trades`,
        ]),
      ];
      rep.extra = {};
      console.log('\nhunting for price/book/trade endpoints:');
      for (const c of cands) {
        const rr = await get(H + c);
        if (rr.status === 404 || rr.status === 0) { console.log(`   ${rr.status}  ${c}`); continue; }
        rep.extra[c] = { status: rr.status,
          keys: rr.json && typeof rr.json === 'object' ? Object.keys(rr.json).slice(0, 15) : null,
          sample: rr.json ? JSON.stringify(rr.json).slice(0, 900) : rr.raw };
        console.log(`   ${rr.status}  ${c}   <<< ${JSON.stringify(Object.keys(rr.json || {}).slice(0, 8))}`);
      }
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2));
  console.log(`\nWrote ${OUT}`);
})();
