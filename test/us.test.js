'use strict';
// Tests for the Polymarket US adapter (us.js). Offline: no network needed.
const assert = require('assert');
const us = require('../us');

const ev = {
  id: '198385', slug: 'btc-updown-15m-2026-10-28-0345z',
  title: 'Bitcoin Up or Down', live: true, ended: false, closed: false,
  startDate: '2026-10-28T03:45:00Z', endDate: '2026-10-28T04:00:00Z',
  markets: [{
    id: '1872583', status: 'MARKET_STATUS_OPEN', feeCoefficient: 0.0695,
    orderPriceMinTickSize: 0.01, minimumTradeQty: 0.01,
    outcomePrices: '["0.2200","0.2300"]',
    bestBidQuote: { value: '0.22' }, bestAskQuote: { value: '0.23' },
    marketSides: [
      { id: '3744632', description: 'Yes', price: '0.2200', long: true, tradable: true, quote: { value: '0.2300' } },
      { id: '3744633', description: 'No', price: '0.2300', long: false, tradable: true, quote: { value: '0.78' } },
    ],
    assetPriceTerms: {
      marketType: 'ASSET_PRICE_MARKET_TYPE_UP_DOWN',
      asset: { assetClass: 'ASSET_CLASS_CRYPTO', symbol: 'btc' },
      indexSymbol: 'BRTI', horizon: '15m',
      windowStart: '2026-10-28T03:45:00Z', windowEnd: '2026-10-28T04:00:00Z',
      priceToBeat: { value: '81079.52', currency: 'USD' },
      settlementPrice: null,
    },
  }],
};

const s = us.shape(ev, 15);
assert.strictEqual(s.slug, 'btc-updown-15m-2026-10-28-0345z');
assert.strictEqual(s.priceToBeat, 81079.52);
assert.strictEqual(s.indexSymbol, 'BRTI');
assert.strictEqual(s.windowStart, '2026-10-28T03:45:00Z');
assert.strictEqual(s.windowEnd, '2026-10-28T04:00:00Z');
assert.strictEqual(s.yesPrice, 0.22);
assert.strictEqual(s.noQuote, 0.78);
assert.strictEqual(s.feeCoefficient, 0.0695);
assert.strictEqual(s.resolvedUp, null, 'unsettled round must not claim an outcome');
assert.strictEqual(s.tradable, true);
console.log('live-shape           OK');

// Settled UP: index finished above the open.
const up = JSON.parse(JSON.stringify(ev));
up.markets[0].assetPriceTerms.settlementPrice = { value: '81100.00' };
assert.strictEqual(us.shape(up, 15).resolvedUp, 1);
// Settled DOWN.
const dn = JSON.parse(JSON.stringify(ev));
dn.markets[0].assetPriceTerms.settlementPrice = { value: '81000.00' };
assert.strictEqual(us.shape(dn, 15).resolvedUp, 0);
// Exactly equal resolves UP, matching "greater than or equal".
const eq = JSON.parse(JSON.stringify(ev));
eq.markets[0].assetPriceTerms.settlementPrice = { value: '81079.52' };
assert.strictEqual(us.shape(eq, 15).resolvedUp, 1);
console.log('settlement logic     OK');

// Slug math across horizons and a UTC day boundary.
const d = new Date(Date.UTC(2026, 9, 28, 3, 52));
assert.strictEqual(us.slugFor(d, 15), 'btc-updown-15m-2026-10-28-0345z');
assert.strictEqual(us.slugFor(d, 5), 'btc-updown-5m-2026-10-28-0350z');
const mid = new Date(Date.UTC(2026, 9, 28, 0, 3));
assert.strictEqual(us.slugFor(mid, 15), 'btc-updown-15m-2026-10-28-0000z');
assert.strictEqual(us.slugFor(new Date(Date.UTC(2026, 9, 27, 23, 59)), 15), 'btc-updown-15m-2026-10-27-2345z');
console.log('slug math            OK');

// Fee: peaks at 0.50, symmetric, zero at the edges.
const c = 0.0695;
assert.ok(Math.abs(us.takerFeePerShare(0.5, c) - 0.017375) < 1e-9);
assert.ok(us.takerFeePerShare(0.5, c) > us.takerFeePerShare(0.7, c));
assert.ok(Math.abs(us.takerFeePerShare(0.3, c) - us.takerFeePerShare(0.7, c)) < 1e-12);
assert.ok(Math.abs(us.breakevenWinRate(0.5, c) - 0.517375) < 1e-9);
console.log('fee math             OK');

// Missing/odd payloads must not throw.
assert.strictEqual(us.shape(null, 15), null);
assert.strictEqual(us.shape({ markets: [] }, 15), null);
const bare = us.shape({ slug: 'x', markets: [{ id: '1' }] }, 5);
assert.strictEqual(bare.priceToBeat, null);
assert.strictEqual(bare.resolvedUp, null);
console.log('defensive parsing    OK');

// A real live round captured from gateway.polymarket.us, not a hand-built one.
{
  const real = require('./fixtures/live-round-15m.json');
  const r = us.shape(real, 15);
  assert.strictEqual(r.slug, 'btc-updown-15m-2026-10-28-0345z');
  assert.strictEqual(r.priceToBeat, 81079.52);
  assert.strictEqual(r.indexSymbol, 'BRTI');
  assert.strictEqual(r.windowStart, '2026-10-28T03:45:00Z');
  assert.strictEqual(r.windowEnd, '2026-10-28T04:00:00Z');
  assert.strictEqual(r.feeCoefficient, 0.0695);
  assert.strictEqual(r.resolvedUp, null, 'a live round must not claim an outcome');
  assert.ok(r.yesPrice > 0 && r.yesPrice < 1, 'yes price parsed');
  assert.strictEqual(us.slugFor(new Date(r.windowStart), 15), r.slug, 'slug math matches reality');
  console.log('real captured payload OK');
}

console.log('\nall us adapter tests passed');
