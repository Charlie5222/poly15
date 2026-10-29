'use strict';
/**
 * probe4-us.js — the /v1/markets list turned out to be a closed-sports archive.
 * Hunt for the endpoint that serves the LIVE board, including BTC up/down.
 * Read-only. No key, no account, no orders.
 */
const fs = require('fs');
const path = require('path');
const HOSTS = ['https://gateway.polymarket.us', 'https://api.polymarket.us'];
const OUT = path.join(__dirname, 'probe4-us.json');

async function get(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, raw: json ? null : text.slice(0, 200) };
  } catch (e) { return { ok: false, status: 0, error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

const PATHS = [
  '/v1/events', '/v1/events?limit=20', '/v1/series', '/v1/series?limit=20',
  '/v1/categories', '/v1/tags', '/v1/markets/search?q=bitcoin',
  '/v1/search?q=bitcoin', '/v1/markets?limit=20&status=open',
  '/v1/markets?limit=20&state=open', '/v1/markets?limit=20&closed=false&active=true',
  '/v1/markets?limit=20&sort=-createdAt', '/v1/markets?limit=20&order=desc',
  '/v1/markets?limit=20&category=crypto&status=open',
  '/v1/crypto/markets', '/v1/markets/live', '/v1/live', '/v1/board',
  '/v1/markets?limit=20&offset=2400',
  '/v2/markets?limit=20', '/markets/v1?limit=20',
  '/v1/instruments?limit=20', '/v1/products?limit=20', '/v1/contracts?limit=20',
];

// Pull any BTC-looking entries out of an arbitrary JSON tree.
function harvestBtc(node, out = [], depth = 0) {
  if (depth > 7 || out.length >= 10) return out;
  if (Array.isArray(node)) { for (const x of node) harvestBtc(x, out, depth + 1); return out; }
  if (node && typeof node === 'object') {
    const strs = Object.entries(node).filter(([, v]) => typeof v === 'string');
    const blob = strs.map(([, v]) => v).join(' ').toLowerCase();
    if (/bitcoin|btc/.test(blob)) {
      out.push(Object.fromEntries(
        Object.entries(node).filter(([, v]) => typeof v !== 'object').slice(0, 20)
      ));
    } else {
      for (const v of Object.values(node)) harvestBtc(v, out, depth + 1);
    }
  }
  return out;
}

(async () => {
  const report = { probedAt: new Date().toISOString(), hits: {}, btc: [] };
  for (const host of HOSTS) {
    for (const p of PATHS) {
      const r = await get(host + p);
      if (r.status === 0 || r.status === 404) continue;  // only record things that exist
      const entry = { status: r.status, ok: r.ok };
      if (r.json) {
        entry.topKeys = typeof r.json === 'object' ? Object.keys(r.json).slice(0, 15) : null;
        const btc = harvestBtc(r.json);
        if (btc.length) { entry.btcCount = btc.length; report.btc.push({ endpoint: host + p, samples: btc.slice(0, 4) }); }
        entry.sample = JSON.stringify(r.json).slice(0, 500);
      } else if (r.raw) entry.raw = r.raw;
      report.hits[host + p] = entry;
      process.stdout.write(`${r.status}  ${host}${p}${entry.btcCount ? '   <<< BTC x' + entry.btcCount : ''}\n`);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n=== endpoints that answered (not 404): ${Object.keys(report.hits).length} ===`);
  console.log(`=== endpoints containing BTC: ${report.btc.length} ===`);
  for (const b of report.btc) console.log('   ' + b.endpoint);
  console.log(`\nWrote ${OUT}`);
})();
