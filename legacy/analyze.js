'use strict';
/** analyze.js — CLI report. Usage: node analyze.js [--entry 60] [--minrounds 20] */

const { buildSamples, runAll, takerFeePerShare } = require('./strategies');

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] != null ? Number(args[i + 1]) : d; };
const ENTRY = argOf('entry', 60);
const MIN = argOf('minrounds', 20);

const { samples, totalRounds, totalSnaps } = buildSamples(ENTRY);
if (!totalRounds) { console.error('No resolved rounds yet. Run record.js for a while first.'); process.exit(1); }
if (samples.length < 3) { console.error(`Only ${samples.length} usable round(s). Keep recording.`); process.exit(1); }

const fsch = samples[0].feeSchedule;
console.log(`Rounds resolved: ${totalRounds} | snapshots: ${totalSnaps} | usable samples: ${samples.length}`);
console.log(`Entry point: ~T-${ENTRY}s before close`);
console.log(`Fee schedule: ${fsch ? JSON.stringify(fsch) : 'none recorded'}`);
if (fsch) {
  const peak = takerFeePerShare(0.5, fsch);
  console.log(`Taker fee at p=0.50: ${peak.toFixed(5)}/share (${(100 * peak / 0.5).toFixed(2)}% of stake)`);
  console.log(`=> a 50c coinflip must win ${(100 * (0.5 + peak)).toFixed(2)}% of the time just to break even.`);
}

function table(title, maker) {
  console.log(`\n${title}`);
  console.log('strategy          n   win%   avg_px  avg_fee  net/share   ROI%   ±2se   verdict');
  console.log('-'.repeat(84));
  for (const r of runAll(samples, { maker, minRounds: MIN })) {
    console.log(
      r.name.padEnd(16) + String(r.n).padStart(4) +
      (100 * r.winRate).toFixed(1).padStart(7) +
      r.avgPrice.toFixed(3).padStart(9) + r.avgFee.toFixed(4).padStart(9) +
      r.pnlPerShare.toFixed(4).padStart(11) + (100 * r.roi).toFixed(2).padStart(8) +
      (2 * r.stderr).toFixed(4).padStart(8) + '   ' + r.verdict
    );
  }
}

table('TAKER (realistic: you cross the spread and pay the fee)', false);
table('MAKER (optimistic: resting fills assumed, zero fee, NOT guaranteed)', true);

console.log(`
"noise" means the result is inside two standard errors of zero. With ~96 rounds
a day you will see streaks that look like skill. Only "POSITIVE" with a few
hundred rounds behind it is worth a second look, and even then it is in-sample.
`);
