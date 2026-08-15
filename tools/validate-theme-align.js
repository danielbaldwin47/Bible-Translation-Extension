#!/usr/bin/env node
/*
 * No-build sanity checks for the theme module's pure cores. Run:
 *   node tools/validate-theme-align.js
 *
 * src/content/theme.js exports them for Node (the DOM half is skipped when
 * `document` is undefined). Two policies are checked here:
 *
 *   nextAlignDelay    after an apply, should the theme re-apply, and when? It
 *                     has to terminate: the site's sticky toolbar height is
 *                     best-effort, so a page where it never resolves must stop
 *                     retrying instead of looping forever.
 *   dominantTextStyle which of the reading column's paragraph styles is the
 *                     one to mirror? The chapter heading is a paragraph too,
 *                     and it comes first in document order — the answer has to
 *                     be "the size most of the text is set in", by character
 *                     count, or the panel mirrors the heading (issue #33).
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

// ---- dominant text style ----
// A sample is one paragraph of the reading column: its computed size/family/
// line-height plus how much text it holds. Order is document order.
const s = (size, chars, font, line) => ({ size, chars, font: font || 'Georgia', line: line || '1.6' });

console.log('dominantTextStyle:');
eq(T.dominantTextStyle([]), null, 'no samples mirror nothing (caller keeps its fallback)');
eq(T.dominantTextStyle(null), null, 'a missing sample list mirrors nothing');

// The bug: the heading is first in document order and bigger, but it is one
// short line against a chapter of verses.
eq(
  T.dominantTextStyle([s('20px', 9), s('17px', 220), s('17px', 180)]).size,
  '17px',
  'the size most of the text is set in wins over the first paragraph',
);
eq(
  T.dominantTextStyle([s('20px', 9), s('17px', 220)]).size,
  '17px',
  'a lone big heading loses to a single verse of body text',
);
eq(
  T.dominantTextStyle([s('14px', 30), s('14px', 40), s('17px', 200)]).size,
  '17px',
  'many small paragraphs still lose to the bulk of the text',
);
eq(
  T.dominantTextStyle([s('17px', 100), s('20px', 60), s('20px', 60)]).size,
  '20px',
  'totals are summed across paragraphs, not compared one at a time',
);

// Family and line-height ride along with the winning size, so the three
// mirrored values describe one real paragraph rather than three.
const mixed = T.dominantTextStyle([
  s('20px', 9, 'Heading, sans-serif', '32px'),
  s('17px', 200, 'Body, serif', '27px'),
]);
eq(mixed, { size: '17px', font: 'Body, serif', line: '27px' }, 'family and line-height come from the winning size');
eq(
  T.dominantTextStyle([s('17px', 40, 'Small, serif', '20px'), s('17px', 300, 'Body, serif', '27px')]).font,
  'Body, serif',
  'within the winning size, the paragraph holding the most text supplies family/line',
);

// Junk in the sample list must not decide the answer.
eq(T.dominantTextStyle([s('17px', 0), s('20px', 5)]).size, '20px', 'empty paragraphs carry no weight');
eq(T.dominantTextStyle([s('', 500), s('17px', 5)]).size, '17px', 'a paragraph with no readable size is skipped');
eq(T.dominantTextStyle([s('', 500)]), null, 'nothing usable in the list mirrors nothing');
eq(
  T.dominantTextStyle([s('17px', 100), s('20px', 100)]).size,
  '17px',
  'a tie goes to whichever came first, so the capture is stable across re-applies',
);

check(T.MAX_TEXT_SAMPLES > 0 && T.MAX_TEXT_SAMPLES <= 100, 'the paragraph sample is bounded (it runs on every re-apply)');

// ---- redundant applies ----
// The theme is woken by the reading column reflowing, and the panel reserves
// page width with a margin on <html> — so wake-ups arrive carrying no new
// styling. Writing on those is how a watcher becomes a loop.
console.log('sameVars:');
const vars = { bg: 'rgb(255,255,255)', fg: 'rgb(20,20,20)', headerBg: 'rgb(240,240,240)', headerH: 48, font: 'Body, serif', size: '17px', line: '27px', dark: false };
const copy = () => Object.assign({}, vars);

check(T.sameVars(vars, copy()), 'an unchanged capture is recognised as unchanged (no write, no loop)');
check(T.sameVars(vars, vars), 'the same object is unchanged');
check(!T.sameVars(vars, null), 'the first capture always writes (nothing to compare against)');
check(!T.sameVars(null, vars), 'a missing capture is never "same"');
for (const key of T.VAR_KEYS) {
  const moved = copy();
  moved[key] = key === 'headerH' ? 64 : key === 'dark' ? true : 'changed';
  check(!T.sameVars(vars, moved), `a change to ${key} is written (it is a mirrored value)`);
}
check(T.sameVars(vars, Object.assign(copy(), { unmirrored: 'x' })), 'a field the panel does not mirror does not force a write');

// ---- line-height is mirrored as a length ----
// The panel multiplies --btx-line by the reader's text-size setting. A ratio
// already scales itself off the (already scaled) font-size, so a unitless value
// here would apply the multiplier twice — 2.56em leading at 1.6x.
console.log('lineHeightOf:');
const lh = (line, size) => T.lineHeightOf({ lineHeight: line, fontSize: size });
eq(lh('27.2px', '17px'), '27.2px', 'a resolved line-height is mirrored as-is');
eq(lh('normal', '17px'), '27.2px', '`normal` is stated in px off the element\'s own size');
eq(lh('normal', '20px'), '32px', '`normal` tracks the element it was read from');
eq(lh('', ''), '27.2px', 'an unreadable style still yields a length');
for (const line of ['27.2px', 'normal', '', undefined]) {
  check(/px$/.test(lh(line, '17px')), `lineHeightOf(${JSON.stringify(line)}) is a length, never a ratio`);
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
