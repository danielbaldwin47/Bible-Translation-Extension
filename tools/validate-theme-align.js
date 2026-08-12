#!/usr/bin/env node
/*
 * No-build sanity checks for the theme module's launch-alignment retry policy.
 * Run:
 *   node tools/validate-theme-align.js
 *
 * src/content/theme.js exports that policy for Node (the DOM half is skipped
 * when `document` is undefined). The policy answers one question — after an
 * apply, should the theme re-apply, and when? — and it has to terminate: the
 * site's sticky toolbar height is best-effort, so a page where it never
 * resolves must stop retrying instead of looping forever.
 *
 * Exits non-zero on any failure so it can gate a commit.
 */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const T = require(path.join(ROOT, 'src/content/theme.js'));

let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); failures++; }
}
function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { console.error(`  ✗ ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failures++; }
}

// Every delay the policy hands out, from a launch where the header height never
// resolves — i.e. the worst case it has to survive.
function fullSchedule() {
  const delays = [];
  for (let attempt = 0; ; attempt++) {
    const delay = T.nextAlignDelay(attempt, false);
    if (delay == null) return delays;
    delays.push(delay);
    if (delays.length > 100) throw new Error('nextAlignDelay never stopped');
  }
}

// ---- stop conditions ----
console.log('nextAlignDelay stop conditions:');
eq(T.nextAlignDelay(0, true), null, 'an aligned first apply schedules nothing');
eq(T.nextAlignDelay(3, true), null, 'alignment mid-run stops the chain');
eq(T.nextAlignDelay(T.ALIGN_ATTEMPTS, false), null, 'the attempt budget stops an unresolvable header');
eq(T.nextAlignDelay(T.ALIGN_ATTEMPTS + 5, false), null, 'past the budget stays stopped');
check(T.nextAlignDelay(0, false) != null, 'an unaligned first apply schedules a retry');

// ---- backoff shape ----
console.log('nextAlignDelay backoff:');
const schedule = fullSchedule();
eq(schedule.length, T.ALIGN_ATTEMPTS, 'the chain runs exactly the attempt budget');
eq(schedule[0], 0, 'the first retry is immediate (next frame, no wait)');
check(schedule.every((d) => typeof d === 'number' && d >= 0), 'every delay is a non-negative number');
check(schedule.every((d, i) => i === 0 || d >= schedule[i - 1]), 'delays never shrink (monotone backoff)');
check(schedule.every((d) => d <= T.ALIGN_MAX_DELAY), `no single delay exceeds ${T.ALIGN_MAX_DELAY}ms (stays responsive)`);
check(schedule.slice(0, 3).reduce((a, b) => a + b, 0) <= 150, 'the first three retries land within 150ms');
const total = schedule.reduce((a, b) => a + b, 0);
check(total > 0 && total <= 3000, `the whole chain gives up within 3s (got ${total}ms)`);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
