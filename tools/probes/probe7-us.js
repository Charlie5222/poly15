'use strict';
/** probe7-us.js — fetch a live BTC up/down round on Polymarket US and locate
 *  its order book. Read-only. No key, no account, no orders. */
const fs = require('fs'); const path = require('path');
const H = 'https://gateway.polymarket.us';
const OUT = path.join(__dirname, 'probe7-us.json');

async function get(u, ms = 12000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: 'application/json' } });
        const x = await r.text(); let j = null; try { j = JSON.parse(x); } catch {}
        return { status: r.status, json: j, raw: j ? null : x.slice(0, 200) }; }
  catch (e) { return { status: 0, error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

function slugFor(date, mins) {
  const ms = mins * 60 * 1000;
  const t = new Date(Math.floor(date.getTime() / ms) * ms);
  const p = (n) => String(n).padStart(2, '0');
  return `btc-updown-${mins}m-${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}-${p(t.getUTCHours())}${p(t.getUTCMinutes())}z`;
}

(async () => {
  const rep = { probedAt: new Date().toISOString(), rounds: {} };
  const now = new Date();

  for (const mins of [15, 5]) {
    // current round and the two before it
    for (let back = 0; back <= 2; back++) {
      const d = new Date(now.getTime() - back * mins * 60000);
      const s = slugFor(d, mins);
      const tries = [`/v1/events?slug=${s}`, `/v1/events/${s}`, `/v1/markets?slug=${s}`];
      for (const t of tries) {
        const r = await get(H + t);
        const ev = r.json?.events?.[0] || r.json?.event || null;
        const mks = r.json?.markets || (ev?.markets) || [];
        const mk = mks[0] || null;
        const key = `${s} via ${t}`;
        rep.rounds[key] = { status: r.status, foundEvent: !!ev, markets: mks.length };
        if (mk) {
          rep.rounds[key].market = Object.fromEntries(
            Object.entries(mk).filter(([, v]) => typeof v !== 'object').slice(0, 30));
          rep.rounds[key].sides = Array.isArray(mk.marketSides)
            ? mk.marketSides.map((x) => Object.fromEntries(
                Object.entries(x).filter(([, v]) => typeof v !== 'object').slice(0, 15)))
            : null;
          if (!rep.firstLiveMarket) rep.firstLiveMarket = { slug: s, mins, market: mk };
        }
        console.log(`${r.status}  ${t}  event=${!!ev} markets=${mks.length}`);
        if (mk) break;
      }
      if (rep.firstLiveMarket && rep.firstLiveMarket.mins === mins) break;
    }
  }

  // Order book hunt on whatever live market we found.
  const live = rep.firstLiveMarket;
  if (live) {
    const mk = live.market;
    const sideIds = Array.isArray(mk.marketSides) ? mk.marketSides.map((s) => s.id) : [];
    console.log(`\nlive market ${mk.id} (${mk.slug}) sides=${JSON.stringify(sideIds)}`);
    const cands = [
      `/v1/markets/${mk.id}/orderbook`, `/v1/markets/${mk.id}/book`,
      `/v1/orderbook?marketId=${mk.id}`, `/v1/orderbook/${mk.id}`,
      `/v1/books?marketId=${mk.id}`, `/v1/markets/${mk.id}/depth`,
      `/v1/markets/${mk.slug}/orderbook`, `/v1/quotes?marketId=${mk.id}`,
      ...sideIds.flatMap((s) => [
        `/v1/orderbook?marketSideId=${s}`, `/v1/orderbook/${s}`,
        `/v1/marketSides/${s}/orderbook`, `/v1/marketSides/${s}/book`,
        `/v1/book?marketSideId=${s}`, `/v1/quotes?marketSideId=${s}`,
      ]),
    ];
    rep.bookTries = {};
    for (const c of cands) {
      const r = await get(H + c);
      if (r.status === 404 || r.status === 0) { console.log(`   ${r.status}  ${c}`); continue; }
      rep.bookTries[c] = { status: r.status,
        keys: r.json && typeof r.json === 'object' ? Object.keys(r.json).slice(0, 15) : null,
        sample: r.json ? JSON.stringify(r.json).slice(0, 800) : r.raw };
      console.log(`   ${r.status}  ${c}   <<< ${JSON.stringify(Object.keys(r.json || {}).slice(0, 8))}`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2));
  console.log(`\nWrote ${OUT}`);
})();
