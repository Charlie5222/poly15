'use strict';
/**
 * probe3-us.js — page the whole public market list and tally categories, so we
 * can say definitively whether Polymarket US lists crypto up/down contracts.
 * Read-only. No key, no account, no orders.
 */
const fs = require('fs');
const path = require('path');
const HOST = 'https://gateway.polymarket.us';
const OUT = path.join(__dirname, 'probe3-us.json');

async function get(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json };
  } catch (e) { return { ok: false, status: 0, error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

const looksCrypto = (m) => {
  const s = `${m.question || ''} ${m.slug || ''} ${m.category || ''}`.toLowerCase();
  return /bitcoin|btc|ethereum|\beth\b|solana|\bsol\b|crypto|xrp/.test(s);
};

(async () => {
  const categories = {};
  const marketTypes = {};
  const cryptoHits = [];
  let total = 0, pages = 0, openNow = 0;
  const now = Date.now();
  let shortDuration = [];

  for (let off = 0; off < 40000; off += 200) {
    const r = await get(`${HOST}/v1/markets?limit=200&offset=${off}`);
    const list = r.json?.markets || [];
    if (!list.length) break;
    pages++; total += list.length;
    for (const m of list) {
      categories[m.category || '(none)'] = (categories[m.category || '(none)'] || 0) + 1;
      if (m.marketType) marketTypes[m.marketType] = (marketTypes[m.marketType] || 0) + 1;
      if (m.active && !m.closed) openNow++;
      if (looksCrypto(m) && cryptoHits.length < 25) cryptoHits.push({
        id: m.id, slug: m.slug, question: m.question, category: m.category,
        active: m.active, closed: m.closed, startDate: m.startDate, endDate: m.endDate,
        feeCoefficient: m.feeCoefficient,
      });
      // Any contract whose window is under an hour is the shape we care about.
      const s = Date.parse(m.startDate), e = Date.parse(m.endDate);
      if (s && e && e > s && (e - s) <= 3600 * 1000 && shortDuration.length < 25) {
        shortDuration.push({ slug: m.slug, question: m.question, category: m.category,
          minutes: Math.round((e - s) / 60000), active: m.active, closed: m.closed });
      }
    }
    if (pages % 5 === 0) process.stdout.write(`  scanned ${total} markets, crypto hits ${cryptoHits.length}\n`);
    if (list.length < 200) break;
  }

  const report = {
    host: HOST, probedAt: new Date().toISOString(),
    totalMarketsScanned: total, pages, openNow,
    categories, marketTypes,
    cryptoHitCount: cryptoHits.length, cryptoHits,
    shortDurationCount: shortDuration.length, shortDuration,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(`\n=== RESULT ===`);
  console.log(`markets scanned : ${total}`);
  console.log(`open right now  : ${openNow}`);
  console.log(`categories      : ${JSON.stringify(categories)}`);
  console.log(`market types    : ${JSON.stringify(marketTypes)}`);
  console.log(`crypto-ish      : ${cryptoHits.length}`);
  console.log(`under one hour  : ${shortDuration.length}`);
  console.log(`\nWrote ${OUT}`);
})();
