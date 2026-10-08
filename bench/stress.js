'use strict';

// Performance baseline for the expansion engine (SPEC-EXPANSION.md appendix).
// Run:  node bench/stress.js
//
// Measures the two hot paths at increasing library sizes:
//   - match per keystroke (a non-matching keystroke that forces a full scan)
//   - live suggestions mid-token
// The algorithm is identical on Android and iOS, so these numbers are a useful
// cross-platform baseline. Compare future engine changes against the table in
// SPEC-EXPANSION.md before accepting them.

const { Expander } = require('../src/expander');

function makeSnippets(n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push({ trigger: ';t' + i, replacement: 'Replacement number ' + i });
  return a;
}

function bench(n, iters) {
  const eng = new Expander(makeSnippets(n));
  for (let k = 0; k < Math.min(2000, iters); k++) { eng.reset(); eng.onChar(';'); eng.onChar('z'); }
  let t0 = process.hrtime.bigint();
  for (let k = 0; k < iters; k++) { eng.reset(); eng.onChar(';'); eng.onChar('z'); } // full scan, matches none
  let t1 = process.hrtime.bigint();
  const perKey = Number(t1 - t0) / (iters * 2) / 1000; // microseconds

  eng.reset(); eng.onChar(';'); eng.onChar('t');
  let s0 = process.hrtime.bigint();
  for (let k = 0; k < iters; k++) eng.suggestions(6);
  let s1 = process.hrtime.bigint();
  const perSug = Number(s1 - s0) / iters / 1000; // microseconds

  return { perKey, perSug };
}

console.log('Expansion engine performance baseline (Node):');
console.log('  snippets |  match/keystroke |  suggestions');
for (const n of [10, 100, 1000, 5000, 10000]) {
  const iters = n >= 10000 ? 2000 : 20000;
  const r = bench(n, iters);
  console.log(
    '  ' + String(n).padStart(8) +
    ' | ' + (r.perKey.toFixed(2) + ' us').padStart(16) +
    ' | ' + (r.perSug < 1000 ? r.perSug.toFixed(1) + ' us' : (r.perSug / 1000).toFixed(2) + ' ms').padStart(11));
}
