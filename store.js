'use strict';
/**
 * store.js: everything recorded, held in memory.
 *
 * The JSONL files on disk are the record and are only ever appended to. They
 * are read once at startup; after that every question is answered from
 * memory, so the UI refreshing every few seconds costs nothing.
 */

const fs = require('fs');
const path = require('path');

const readJSONL = (f) => {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

/** Count lines without parsing them (snapshots run to many megabytes). */
function countLines(f) {
  if (!fs.existsSync(f)) return 0;
  const fd = fs.openSync(f, 'r');
  const buf = Buffer.alloc(1 << 20);
  let n = 0, read;
  try {
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < read; i++) if (buf[i] === 10) n++;
    }
  } finally { fs.closeSync(fd); }
  return n;
}

const PRIMARY_ENTRY = 60;
const keyOf = (slug, entry) => `${slug}@${entry}`;

/**
 * Bets recorded before v2 had no explicit stake: price, fee and P&L were per
 * share. Re-express them as the same $10 bet the app now makes, so old and new
 * rows add up in the same units.
 */
function normalizeScored(r) {
  if (r.entry == null) r.entry = PRIMARY_ENTRY;
  if (r.stake == null && Number.isFinite(r.price)) {
    const per = r.price + (r.fee || 0);
    r.shares = 10 / per;
    r.stake = 10;
    r.pnl = (r.won ? r.shares : 0) - 10;
    r.legacy = true;
  }
  return r;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.f = {
      snap: path.join(dir, 'snapshots.jsonl'),
      rounds: path.join(dir, 'rounds.jsonl'),
      preds: path.join(dir, 'predictions.jsonl'),
      scored: path.join(dir, 'scored.jsonl'),
      fills: path.join(dir, 'maker-fills.jsonl'),
      checked: path.join(dir, 'outcomes-checked.jsonl'),
    };
    this.version = 0;
    this.lastError = null;

    this.preds = new Map();          // key -> prediction record
    for (const p of readJSONL(this.f.preds)) {
      if (p.entry == null) p.entry = PRIMARY_ENTRY;
      this.preds.set(keyOf(p.slug, p.entry), p);
    }
    for (const f of readJSONL(this.f.fills)) {
      const o = this.preds.get(f.key)?.maker?.find((m) => m.strategy === f.strategy);
      if (o) { o.filled = true; o.filledAt = f.ts; }
    }
    this.scored = readJSONL(this.f.scored).map(normalizeScored);
    // Results re-checked against the exchange's official settlement. The
    // original rows stay on disk untouched; corrections apply on load.
    this.checked = new Map();
    for (const c of readJSONL(this.f.checked)) this.checked.set(c.slug, c.resolvedUp);
    for (const r of this.scored) this.applyOutcome(r);
    this.scoredKeys = new Set(this.scored.map((r) => keyOf(r.slug, r.entry)));
    this.rounds = new Map();         // slug -> { horizon, resolvedUp }
    for (const r of readJSONL(this.f.rounds)) this.rounds.set(r.slug, { horizon: r.horizon, resolvedUp: r.resolvedUp, v2: !!r.v2 });
    this.snapshots = countLines(this.f.snap);
  }

  applyOutcome(r) {
    const truth = this.checked.get(r.slug);
    if (truth == null || truth === r.resolvedUp) return;
    r.recordedAs = r.resolvedUp;
    r.resolvedUp = truth;
    if (r.filled === false) return;
    r.won = (r.side === 'UP') === (truth === 1);
    r.pnl = (r.won ? r.shares : 0) - r.stake;
  }

  /** Rounds settled by v1, whose results have not been re-checked yet. */
  needsCheck() {
    const out = new Set();
    for (const r of this.scored) if (r.modelVersion !== 2 && !this.checked.has(r.slug)) out.add(r.slug);
    for (const [slug, r] of this.rounds) if (!this.checked.has(slug) && !r.v2) out.add(slug);
    return [...out];
  }

  recordCheck(slug, resolvedUp, was) {
    this.checked.set(slug, resolvedUp);
    this.append(this.f.checked, { slug, resolvedUp, was, checkedAt: new Date().toISOString() });
    if (this.rounds.has(slug)) this.rounds.get(slug).resolvedUp = resolvedUp;
    for (const r of this.scored) if (r.slug === slug) this.applyOutcome(r);
    this.version++;
  }

  append(file, obj) {
    try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch (e) { this.lastError = e.message; }
  }

  addSnapshot(s) { this.append(this.f.snap, s); this.snapshots++; }

  addRound(r) {
    if (this.rounds.has(r.slug)) return false;
    this.rounds.set(r.slug, { horizon: r.horizon, resolvedUp: r.resolvedUp, v2: true });
    this.append(this.f.rounds, { ...r, v2: true });
    this.version++;
    return true;
  }

  hasPrediction(slug, entry) { return this.preds.has(keyOf(slug, entry)); }

  addPrediction(rec) {
    this.preds.set(keyOf(rec.slug, rec.entry), rec);
    this.append(this.f.preds, rec);
    this.version++;
  }

  markMakerFill(rec, order, ts) {
    order.filled = true; order.filledAt = ts;
    this.append(this.f.fills, { key: keyOf(rec.slug, rec.entry), strategy: order.strategy, ts });
    this.version++;
  }

  isScored(rec) { return this.scoredKeys.has(keyOf(rec.slug, rec.entry)); }

  addScored(rec, rows) {
    for (const r of rows) { this.scored.push(r); this.append(this.f.scored, r); }
    this.scoredKeys.add(keyOf(rec.slug, rec.entry));
    this.version++;
  }

  /** Predictions whose round has not been scored yet, oldest first. */
  unscored() { return [...this.preds.values()].filter((p) => !this.isScored(p)); }

  /** Rounds that have been scored at least once (any entry). */
  scoredRounds() { return new Set(this.scored.map((r) => r.slug)).size; }
}

module.exports = { Store, readJSONL, countLines, keyOf, PRIMARY_ENTRY, normalizeScored };
