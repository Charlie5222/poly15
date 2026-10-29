'use strict';
/**
 * record.js — read-only observer for Polymarket BTC 15m Up/Down rounds.
 *
 * Connects to nothing but public endpoints. No wallet, no API key, no orders.
 * Appends two JSONL files under ./data:
 *   snapshots.jsonl — one line per order-book poll
 *   rounds.jsonl    — one line per resolved round (the ground-truth label)
 */

const fs = require('fs');
const path = require('path');
const {
  ROUND_SECS, roundStart, slugFor, fetchEventBySlug, shapeRound,
  fetchBook, fetchSpot, sleep, dataDir,
} = require('./lib');

const DATA = dataDir();
const SNAP_FILE = path.join(DATA, 'snapshots.jsonl');
const ROUND_FILE = path.join(DATA, 'rounds.jsonl');
const POLL_MS = Number(process.env.POLL_MS || 15000);

fs.mkdirSync(DATA, { recursive: true });
const append = (f, obj) => fs.appendFileSync(f, JSON.stringify(obj) + '\n');

const seenResolved = new Set();
if (fs.existsSync(ROUND_FILE)) {
  for (const line of fs.readFileSync(ROUND_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { seenResolved.add(JSON.parse(line).slug); } catch {}
  }
}

const roundCache = new Map(); // slug -> shaped round metadata

async function getRound(slug, { refresh = false } = {}) {
  if (!refresh && roundCache.has(slug)) return roundCache.get(slug);
  const r = shapeRound(await fetchEventBySlug(slug));
  if (r) roundCache.set(slug, r);
  return r;
}

async function snapshotCurrent() {
  const now = Date.now();
  const start = roundStart(now);
  const slug = slugFor(start);
  const secsToClose = start + ROUND_SECS - Math.floor(now / 1000);

  const round = await getRound(slug);
  if (!round) { console.log(`[${new Date().toISOString()}] ${slug}: not listed yet`); return; }
  if (!round.upTokenId) { console.log(`${slug}: no CLOB token ids`); return; }

  const [book, downBook, spot] = await Promise.all([
    fetchBook(round.upTokenId).catch((e) => ({ error: String(e.message || e) })),
    round.downTokenId
      ? fetchBook(round.downTokenId).catch((e) => ({ error: String(e.message || e) }))
      : Promise.resolve(null),
    fetchSpot().catch(() => null),
  ]);

  const mid = (book.bestBid != null && book.bestAsk != null)
    ? (book.bestBid + book.bestAsk) / 2 : null;
  const spotVsOpen = (spot != null && round.priceToBeat != null)
    ? spot - round.priceToBeat : null;

  append(SNAP_FILE, {
    ts: new Date().toISOString(),
    slug,
    secsToClose,
    priceToBeat: round.priceToBeat,
    spot,
    // Positive => spot is above the round's opening price, i.e. "Up" is
    // currently winning on our proxy feed.
    spotVsOpen,
    up: book,
    down: downBook,
    upMid: mid,
    spread: (book.bestBid != null && book.bestAsk != null) ? book.bestAsk - book.bestBid : null,
    feeSchedule: round.feeSchedule,
    feeType: round.feeType,
  });

  const fmt = (v, d = 4) => (v == null ? '--' : Number(v).toFixed(d));
  console.log(
    `[${new Date().toISOString()}] ${slug} T-${String(secsToClose).padStart(3)}s  ` +
    `up_mid=${fmt(mid, 3)} spread=${fmt(book.bestAsk - book.bestBid, 3)} ` +
    `spot=${fmt(spot, 0)} vs_open=${fmt(spotVsOpen, 1)}`
  );
}

// Re-fetch rounds that have ended so we capture the resolved outcome.
async function harvestResolved() {
  const nowStart = roundStart();
  for (let back = 1; back <= 6; back++) {
    const start = nowStart - back * ROUND_SECS;
    const slug = slugFor(start);
    if (seenResolved.has(slug)) continue;
    let r;
    try { r = await getRound(slug, { refresh: true }); } catch { continue; }
    if (!r || r.resolvedUp == null) continue;
    append(ROUND_FILE, {
      slug: r.slug,
      title: r.title,
      startTime: r.startTime,
      endDate: r.endDate,
      resolvedUp: r.resolvedUp,
      priceToBeat: r.priceToBeat,
      finalPrice: r.finalPrice,
      feeSchedule: r.feeSchedule,
      feeType: r.feeType,
      harvestedAt: new Date().toISOString(),
    });
    seenResolved.add(slug);
    console.log(`  resolved ${slug}: ${r.resolvedUp ? 'UP' : 'DOWN'}`);
  }
}

async function main() {
  console.log(`recording -> ${DATA}  (poll ${POLL_MS}ms, Ctrl+C to stop)`);
  console.log('read-only: no wallet, no API key, no orders\n');
  for (;;) {
    try { await snapshotCurrent(); } catch (e) { console.error('snapshot:', e.message); }
    try { await harvestResolved(); } catch (e) { console.error('harvest:', e.message); }
    await sleep(POLL_MS);
  }
}

if (require.main === module) main();
