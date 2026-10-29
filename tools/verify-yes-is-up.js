'use strict';
/**
 * verify-yes-is-up.js
 *
 * poly15 assumes the market's "Yes" side means "BTC finishes Up". The market
 * text says it "settles to Up" without naming which outcome that is, so this
 * checks it against settled rounds: for each one, did the side Polymarket paid
 * out (outcomePrices) match the direction the settlement price moved?
 *
 * Read-only. Public data only. Writes verify-yes-is-up.json next to itself.
 * Run with:  node tools/verify-yes-is-up.js
 */
const fs = require('fs');
const path = require('path');
const us = require('../us');

const OUT = path.join(__dirname, 'verify-yes-is-up.json');
const LOOKBACK = Number(process.env.ROUNDS || 40);   // per horizon

(async () => {
  const rows = [];
  const now = Date.now();
  for (const mins of [15, 5]) {
    for (let back = 2; back < LOOKBACK + 2; back++) {
      const d = new Date(now - back * mins * 60000);
      let j;
      try { j = await us.getJSON(`${us.GATEWAY}/v1/events?slug=${us.slugFor(d, mins)}`); }
      catch { continue; }
      const ev = j?.events?.[0], mk = ev?.markets?.[0];
      if (!mk) continue;
      const t = mk.assetPriceTerms || {};
      const ptb = us.num(t.priceToBeat?.value);
      const settle = us.num(t.settlementPrice?.value ?? t.settlementPrice);
      let paid = mk.outcomePrices;
      try { paid = JSON.parse(paid); } catch {}
      const outcomes = (() => { try { return JSON.parse(mk.outcomes); } catch { return mk.outcomes; } })();
      if (ptb == null || settle == null || !Array.isArray(paid)) continue;
      const yesPaid = paid[0] === '1' || paid[0] === 1 || Number(paid[0]) > 0.99;
      const noPaid = paid[0] === '0' || paid[0] === 0 || Number(paid[0]) < 0.01;
      if (!yesPaid && !noPaid) continue;           // not settled yet
      const wentUp = settle >= ptb;
      rows.push({ slug: ev.slug, horizon: mins, outcomes, priceToBeat: ptb,
        settlementPrice: settle, wentUp, yesPaid, agrees: wentUp === yesPaid });
    }
  }
  const agree = rows.filter((r) => r.agrees).length;
  const report = {
    checkedAt: new Date().toISOString(),
    rounds: rows.length, agree, disagree: rows.length - agree,
    verdict: !rows.length ? 'no settled rounds found'
      : agree === rows.length ? 'CONFIRMED: Yes pays out exactly when BTC finished up'
      : agree === 0 ? 'INVERTED: Yes pays out when BTC finished DOWN'
      : 'MIXED: some rounds disagree, inspect them',
    mismatches: rows.filter((r) => !r.agrees),
    sample: rows.slice(0, 6),
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`${report.verdict}\n${agree}/${rows.length} settled rounds agree.\nWrote ${OUT}`);
})();
