'use strict';
/** Runs every *.test.js in this folder and exits non-zero if any fails. */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`\n=== ${f} ${ok ? 'PASS' : 'FAIL'} ===`);
  process.stdout.write(r.stdout);
  if (!ok) process.stdout.write(r.stderr);
}
console.log(`\n${files.length - failed}/${files.length} suites passed`);
process.exit(failed ? 1 : 0);
