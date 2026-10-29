'use strict';
/** probe6-us.js — find the short-duration BTC series. Read-only, no key, no orders. */
const fs = require('fs'); const path = require('path');
const H = 'https://gateway.polymarket.us';
const OUT = path.join(__dirname, 'probe6-us.json');

async function get(u, ms = 12000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: 'application/json' } });
        const x = await r.text(); let j = null; try { j = JSON.parse(x); } catch {}
        return { status: r.status, json: j }; }
  catch (e) { return { status: 0, error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

(async () => {
  const rep = { probedAt: new Date().toISOString() };

  const series = (await get(`${H}/v1/series?limit=500`)).json?.series || [];
  rep.seriesCount = series.length;
  rep.allSeries = series.map((s) => ({ id: s.id, slug: s.slug, title: s.title }));
  console.log(`=== SERIES (${series.length}) ===`);
  for (const s of series) console.log(`  id=${s.id} slug=${s.slug} title=${JSON.stringify(s.title)}`);

  const tags = (await get(`${H}/v1/tags?limit=1000`)).json?.tags || [];
  rep.tagCount = tags.length;
  const shortTags = tags.filter((t) => /15|5m|min|hour|hourly|4h|1h|daily|up.?down/i.test(`${t.slug} ${t.label}`));
  rep.shortTags = shortTags.map((t) => ({ id: t.id, slug: t.slug, label: t.label, parentId: t.parentId }));
  console.log(`\n=== SHORT-DURATION TAGS (${shortTags.length} of ${tags.length}) ===`);
  for (const t of shortTags) console.log(`  id=${t.id} slug=${t.slug} label=${JSON.stringify(t.label)} parent=${t.parentId}`);

  // Page the Bitcoin series fully, plus any other crypto-looking series.
  const cryptoSeries = series.filter((s) => /btc|bitcoin|eth|sol|xrp|crypto/i.test(`${s.slug} ${s.title}`));
  rep.cryptoSeries = cryptoSeries.map((s) => ({ id: s.id, slug: s.slug, title: s.title }));
  rep.seriesEvents = {};
  const shortEvents = [];

  for (const s of cryptoSeries) {
    for (let off = 0; off < 400; off += 100) {
      const r = await get(`${H}/v1/events?seriesId=${s.id}&limit=100&offset=${off}`);
      const evs = r.json?.events || [];
      if (!evs.length) break;
      for (const e of evs) {
        const mk = Array.isArray(e.markets) ? e.markets[0] : null;
        const st = Date.parse(mk?.startDate || e.startDate), en = Date.parse(mk?.endDate || e.endDate);
        const mins = (st && en && en > st) ? Math.round((en - st) / 60000) : null;
        if (mins != null && mins <= 70) {
          shortEvents.push({
            seriesId: s.id, seriesSlug: s.slug, eventSlug: e.slug, title: e.title,
            minutes: mins, active: e.active, closed: e.closed,
            marketId: mk?.id, marketSlug: mk?.slug, status: mk?.status,
            outcomes: mk?.outcomes, outcomePrices: mk?.outcomePrices,
            feeCoefficient: mk?.feeCoefficient, tick: mk?.orderPriceMinTickSize,
            minQty: mk?.minimumTradeQty,
            sides: Array.isArray(mk?.marketSides)
              ? mk.marketSides.map((x) => ({ id: x.id, desc: x.description, price: x.price, long: x.long }))
              : null,
          });
        }
      }
      rep.seriesEvents[`${s.slug}@${off}`] = { n: evs.length, sampleTitles: evs.slice(0, 3).map((e) => e.title) };
      console.log(`  series ${s.slug} offset=${off} n=${evs.length} shortFound=${shortEvents.length}`);
      if (evs.length < 100) break;
    }
  }

  rep.shortEventCount = shortEvents.length;
  rep.shortEvents = shortEvents.slice(0, 12);
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2));
  console.log(`\n=== SHORT-DURATION CRYPTO EVENTS FOUND: ${shortEvents.length} ===`);
  for (const e of shortEvents.slice(0, 8)) console.log(`  ${e.minutes}min  ${e.eventSlug}  ${e.title}  status=${e.status}`);
  console.log(`\nWrote ${OUT}`);
})();
