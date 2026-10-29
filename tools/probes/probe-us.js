'use strict';
/**
 * probe-us.js — read-only reconnaissance of the Polymarket US public gateway.
 * Hits only public market-data endpoints. No key, no account, no orders.
 * Writes probe-us.json next to this script.
 */
const fs = require('fs');
const path = require('path');

const HOST = 'https://gateway.polymarket.us';
const OUT = path.join(__dirname, 'probe-us.json');

async function get(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, raw: json ? null : text.slice(0, 600) };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  } finally { clearTimeout(t); }
}

// Candidate paths; we do not know the exact scheme, so try a spread and record all.
const CANDIDATES = [
  '/markets?limit=5',
  '/markets',
  '/events?limit=5',
  '/series',
  '/v1/markets?limit=5',
  '/api/markets?limit=5',
  '/public-search?q=bitcoin',
  '/search?q=bitcoin',
  '/markets?search=bitcoin',
  '/',
];

// Pull out the field names of a representative object so we learn the schema.
function shapeOf(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth > 2 ? `array(${v.length})` : [`array(${v.length})`, v.length ? shapeOf(v[0], depth + 1) : null];
  if (typeof v === 'object') {
    if (depth > 2) return 'object';
    const o = {};
    for (const k of Object.keys(v).slice(0, 40)) o[k] = shapeOf(v[k], depth + 1);
    return o;
  }
  return typeof v;
}

function findBtcish(node, hits = [], depth = 0) {
  if (depth > 6 || hits.length >= 8) return hits;
  if (Array.isArray(node)) { for (const x of node) findBtcish(x, hits, depth + 1); return hits; }
  if (node && typeof node === 'object') {
    const blob = JSON.stringify(
      Object.fromEntries(Object.entries(node).filter(([, v]) => typeof v === 'string').slice(0, 20))
    ).toLowerCase();
    if (/bitcoin|btc/.test(blob) && /up|down|15|hour|minute/.test(blob)) hits.push(node);
    else for (const v of Object.values(node)) findBtcish(v, hits, depth + 1);
  }
  return hits;
}

(async () => {
  const report = { host: HOST, probedAt: new Date().toISOString(), node: process.version, endpoints: {} };

  for (const p of CANDIDATES) {
    const r = await get(HOST + p);
    const entry = { status: r.status, ok: r.ok };
    if (r.error) entry.error = r.error;
    if (r.raw) entry.rawSnippet = r.raw;
    if (r.json) {
      entry.shape = shapeOf(r.json);
      const btc = findBtcish(r.json);
      if (btc.length) {
        entry.btcCandidates = btc.slice(0, 3).map((o) =>
          Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v !== 'object').slice(0, 25))
        );
      }
      entry.sample = JSON.stringify(r.json).slice(0, 1200);
    }
    report.endpoints[p] = entry;
    process.stdout.write(`${p} -> ${r.status}${r.error ? ' ' + r.error : ''}\n`);
  }

  const reachable = Object.values(report.endpoints).some((e) => e.status > 0);
  report.summary = {
    hostReachable: reachable,
    okEndpoints: Object.entries(report.endpoints).filter(([, e]) => e.ok).map(([k]) => k),
    anyBtcCandidates: Object.values(report.endpoints).some((e) => e.btcCandidates?.length),
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log(`host reachable: ${reachable}`);
  console.log(`endpoints that answered OK: ${report.summary.okEndpoints.join(', ') || '(none)'}`);
  console.log(`found BTC-ish markets: ${report.summary.anyBtcCandidates}`);
})();
