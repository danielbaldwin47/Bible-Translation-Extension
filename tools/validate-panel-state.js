#!/usr/bin/env node
/*
 * No-build sanity checks for the panel's pure state core. Run:
 *   node tools/validate-panel-state.js
 *
 * src/content/panel.js exports its state machine for Node (the DOM shell is
 * skipped when `document` is undefined). These checks pin down the toggle
 * semantics that used to live scattered in content.js callbacks: what a mode
 * click means, when the citation-layout toggle acts, and how a non-Bible
 * chapter forces citations — plus the view host's caching rules, which used to
 * be the orchestrator's citCache/transCache bookkeeping.
 *
 * Exits non-zero on any failure so it can gate a commit.
 */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'src/content/panel.js'));

let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); failures++; }
}
function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { console.error(`  ✗ ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failures++; }
}

function fresh(init) {
  return P.createState(init || {});
}

// ---- createState ----
console.log('createState:');
let s = fresh();
eq(s.mode, 'translation', 'mode defaults to translation');
eq(s.citationView, 'source', 'citationView defaults to source');
eq(s.collapsed, false, 'collapsed defaults to false');
eq(s.isBible, true, 'a fresh panel assumes a Bible chapter');

s = fresh({ mode: 'citations', citationView: 'verse', collapsed: true });
eq(s.mode, 'citations', 'persisted mode is adopted');
eq(s.citationView, 'verse', 'persisted citationView is adopted');
eq(s.collapsed, true, 'persisted collapsed is adopted');

s = fresh({ mode: 'nonsense', citationView: 42, collapsed: 'yes' });
eq(s.mode, 'translation', 'garbage mode falls back to translation');
eq(s.citationView, 'source', 'garbage citationView falls back to source');
eq(s.collapsed, false, 'garbage collapsed falls back to false');

// ---- effectiveMode ----
console.log('effectiveMode:');
s = fresh({ mode: 'translation' });
eq(P.effectiveMode(s), 'translation', 'Bible + translation preference -> translation');
s.mode = 'citations';
eq(P.effectiveMode(s), 'citations', 'Bible + citations preference -> citations');
s.mode = 'translation';
s.isBible = false;
eq(P.effectiveMode(s), 'citations', 'non-Bible forces citations regardless of preference');

// ---- selectMode ----
console.log('selectMode:');
s = fresh({ mode: 'translation' });
eq(P.selectMode(s, 'citations'), true, 'switching mode reports a change');
eq(s.mode, 'citations', '...and lands in the new mode');
eq(P.selectMode(s, 'citations'), false, 're-selecting the current mode is a no-op');
eq(P.selectMode(s, 'translation'), true, 'switching back reports a change');

s = fresh({ mode: 'translation' });
s.isBible = false;
eq(P.selectMode(s, 'citations'), false, 'mode clicks are ignored on non-Bible chapters');
eq(s.mode, 'translation', '...and the Bible-chapter preference is untouched');

s = fresh({ mode: 'translation' });
eq(P.selectMode(s, 'bogus'), false, 'a garbage mode click cannot corrupt state');
eq(s.mode, 'translation', '...and the mode is unchanged');

// ---- selectCitationView ----
console.log('selectCitationView:');
s = fresh({ mode: 'citations', citationView: 'source' });
eq(P.selectCitationView(s, 'verse'), true, 'switching layout in citations mode reports a change');
eq(s.citationView, 'verse', '...and lands on the new layout');
eq(P.selectCitationView(s, 'verse'), false, 're-selecting the current layout is a no-op');

s = fresh({ mode: 'translation', citationView: 'source' });
eq(P.selectCitationView(s, 'verse'), false, 'the layout toggle only acts while citations are showing');
eq(s.citationView, 'source', '...and the stored layout is untouched');

s = fresh({ mode: 'translation', citationView: 'source' });
s.isBible = false; // citations forced -> the toggle acts even though mode pref is translation
eq(P.selectCitationView(s, 'verse'), true, 'forced citations (non-Bible) counts as citations showing');

// ---- setBible ----
console.log('setBible:');
s = fresh({ mode: 'translation' });
eq(P.setBible(s, true), false, 'Bible -> Bible does not change the effective mode');
eq(P.setBible(s, false), true, 'Bible -> non-Bible flips effective mode to citations');
eq(P.effectiveMode(s), 'citations', '...effective mode is citations');
eq(s.mode, 'translation', '...but the Bible-chapter preference survives');
eq(P.setBible(s, true), true, 'non-Bible -> Bible restores the preferred mode (a change)');
eq(P.effectiveMode(s), 'translation', '...effective mode is translation again');

s = fresh({ mode: 'citations' });
eq(P.setBible(s, false), false, 'citations preference: Bible -> non-Bible is not an effective change');

// ---- View host ----
// The DOM node is opaque to the core, so `{ name, key }` stands in for one.
// `show` is what the shell's showView does around selectView: on a rebuild it
// attaches a container, runs the render, and settles the entry. `produced`
// mirrors the shell's "the render left something in the container" test.
function show(v, name, key, opts) {
  const o = opts || {};
  const r = P.selectView(v, name, key, o.cache);
  if (r.action === 'build') {
    r.entry.node = { name, key };
    if (o.mark !== undefined) P.keepView(v, o.mark); // what the view said while rendering
    P.settleView(r.entry, o.produced !== false);
  }
  return r;
}

console.log('view host:');
let v = P.createViews();
eq(v.active, null, 'a fresh host has nothing mounted');

let r = show(v, 'citations', 'john/3::source');
eq(r.action, 'build', 'the first request for a view builds it');
eq(v.active, 'citations', '...and mounts it');

P.saveViewScroll(v, 420);
r = show(v, 'translation', 'john/3::niv');
eq(r.action, 'build', 'another name is another view');
eq(v.entries.citations.scrollTop, 420, "...and the outgoing view's scroll was recorded");

P.saveViewScroll(v, 90);
r = show(v, 'citations', 'john/3::source');
eq(r.action, 'restore', 'coming back to the same content re-mounts it');
eq(r.entry.scrollTop, 420, '...at the scroll offset it was left at');
eq(v.entries.translation.scrollTop, 0, '...while translation, being page-driven, saved nothing');

v = P.createViews();
show(v, 'citations', 'john/3::source');
r = show(v, 'citations', 'john/3::verse');
eq(r.action, 'build', 'a different key rebuilds instead of re-mounting');
r = show(v, 'citations', 'john/3::source');
eq(r.action, 'build', '...and the superseded body is gone (one slot per name)');

// cache:false — the talk reader, which must re-open from scratch every time.
v = P.createViews();
show(v, 'talk', 'talk-1#c9', { cache: false });
r = show(v, 'talk', 'talk-1#c9', { cache: false });
eq(r.action, 'build', 'an uncacheable view is rebuilt even for the same key');

// A body earns its slot. What a view says while rendering wins over the
// host's default, so a spinner or an error is never re-mounted in place of a
// retry — and a render that bailed out after an await caches nothing at all.
v = P.createViews();
show(v, 'translation', 'john/3::niv', { mark: false });
r = show(v, 'translation', 'john/3::niv');
eq(r.action, 'build', 'a view that marked itself not-worth-keeping is rebuilt');

v = P.createViews();
show(v, 'translation', 'john/3::niv', { mark: true, produced: false });
r = show(v, 'translation', 'john/3::niv');
eq(r.action, 'restore', 'a view that marked itself worth keeping is re-mounted');

v = P.createViews();
show(v, 'translation', 'john/3::niv', { produced: false });
r = show(v, 'translation', 'john/3::niv');
eq(r.action, 'build', 'a render that painted nothing leaves no cached body');

v = P.createViews();
show(v, 'citations', 'john/3::source', { produced: true });
r = show(v, 'citations', 'john/3::source');
eq(r.action, 'restore', 'a render that finished and painted earns its slot');

P.keepView(P.createViews(), true); // no mounted view -> no throw
check(true, 'keepView with nothing mounted is a no-op');

// dropViews — a new chapter invalidates everything at once.
v = P.createViews();
show(v, 'citations', 'john/3::source');
show(v, 'translation', 'john/3::niv');
P.dropViews(v);
eq(v.active, null, 'dropping views unmounts');
eq(show(v, 'citations', 'john/3::source').action, 'build', '...and nothing survives to re-mount');

// Scroll bookkeeping is defensive: garbage never becomes a scroll offset.
v = P.createViews();
show(v, 'citations', 'k');
P.saveViewScroll(v, -30);
eq(v.entries.citations.scrollTop, 0, 'a negative scroll clamps to the top');
P.saveViewScroll(v, undefined);
eq(v.entries.citations.scrollTop, 0, 'a missing scroll reads as the top');

// ---- Who owns a view's scroll position ----
// Translation mirrors the page, so it must not also save/restore an offset —
// the two would fight over the same body on every page scroll.
console.log('scroll ownership:');
eq(P.viewRestoresScroll('citations'), true, 'citations owns its scroll position');
eq(P.viewRestoresScroll('talk'), true, 'the talk reader owns its scroll position');
eq(P.viewRestoresScroll('translation'), false, 'translation is page-driven, so it does not restore');
eq(P.viewRestoresScroll(null), true, 'an unknown view defaults to owning its scroll');

v = P.createViews();
show(v, 'translation', 'john/3::niv');
P.saveViewScroll(v, 500);
eq(v.entries.translation.scrollTop, 0, 'a page-synced view records no offset to come back to');

v = P.createViews();
show(v, 'citations', 'john/3::source');
P.saveViewScroll(v, 500);
show(v, 'translation', 'john/3::niv');
P.saveViewScroll(v, 800); // the page-synced view's own scroll must not leak
r = show(v, 'citations', 'john/3::source');
eq(r.action, 'restore', 'citations still re-mounts across a translation detour');
eq(r.entry.scrollTop, 500, '...at its own saved offset, untouched by scroll-sync');

// ---- Damped scroll step ----
// The body eases toward a target instead of teleporting. Frame-rate
// independent: the same elapsed time must cover the same distance whether the
// display runs at 60Hz or 120Hz.
console.log('scrollStep:');
const TAU = 90;
check(P.scrollStep(0, 1000, 16, TAU) > 0, 'a step moves toward the target');
check(P.scrollStep(0, 1000, 16, TAU) < 1000, '...without arriving in one frame');
check(P.scrollStep(1000, 0, 16, TAU) < 1000, 'a step moves downward too');
check(P.scrollStep(1000, 0, 16, TAU) > 0, '...without overshooting past the target');

const oneBigFrame = P.scrollStep(0, 1000, 16, TAU);
const twoHalfFrames = P.scrollStep(P.scrollStep(0, 1000, 8, TAU), 1000, 8, TAU);
check(Math.abs(oneBigFrame - twoHalfFrames) < 1, 'one 16ms frame covers what two 8ms frames do (frame-rate independent)');

let pos = 0;
for (let i = 0; i < 600; i++) pos = P.scrollStep(pos, 1000, 16, TAU);
check(Math.abs(1000 - pos) < 0.5, 'the chase converges on its target');

check(P.scrollStep(0, 1000, 16, 0) === 1000, 'a non-positive tau means no easing — land on the target');
// A duplicate or backwards rAF timestamp must not be read as "arrive now":
// no time has passed, so nothing moves. Teleporting here would be the snap.
check(P.scrollStep(0, 1000, 0, TAU) === 0, 'a zero-length frame holds position');
check(P.scrollStep(400, 1000, -5, TAU) === 400, 'a backwards timestamp holds position');
check(P.scrollStep(250, 250, 16, TAU) === 250, 'a step toward where we already are stays put');
check(P.scrollStep(undefined, 400, 16, TAU) >= 0, 'garbage input cannot produce a negative position');

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
