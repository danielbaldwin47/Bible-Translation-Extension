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
// Translation records its offset like everyone else — it is being page-driven
// that stops the number being *read*, not written (see scroll ownership below).
eq(v.entries.translation.scrollTop, 90, '...and so was the page-driven view, harmlessly');

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

// With scroll-sync switched off there is no page-driven view at all: nothing
// else is going to place the Translation body, so it must save and restore its
// own offset like every other view.
eq(P.viewRestoresScroll('translation', false), true, 'sync off -> translation owns its scroll too');
eq(P.viewRestoresScroll('translation', true), false, 'sync on -> translation is page-driven again');
eq(P.viewRestoresScroll('citations', false), true, 'sync off changes nothing for citations');

// Recording is unconditional; only *restoring* is a matter of ownership. A
// page-synced view that recorded nothing would come back to the top of the
// chapter if the setting took the page away from it while the view was cached.
v = P.createViews();
show(v, 'translation', 'john/3::niv');
P.saveViewScroll(v, 500);
eq(v.entries.translation.scrollTop, 500, 'even a page-synced view records where it was left');

// The ordering that made this necessary: read Translation with sync on, detour
// to Citations, turn the setting off, come back. The offset recorded on the way
// out is what the view now owns — a 0 there would jump the reader to the top.
v = P.createViews();
show(v, 'translation', 'john/3::niv');
P.saveViewScroll(v, 400); // leaving Translation while it was still page-synced
show(v, 'citations', 'john/3::source');
P.saveViewScroll(v, 120);
r = show(v, 'translation', 'john/3::niv');
eq(r.action, 'restore', 'Translation re-mounts across the detour');
eq(P.viewRestoresScroll('translation', false), true, '...and with sync now off it owns its scroll');
eq(r.entry.scrollTop, 400, '...so it comes back where the reader was, not to the top');

v = P.createViews();
show(v, 'citations', 'john/3::source');
P.saveViewScroll(v, 500);
show(v, 'translation', 'john/3::niv');
P.saveViewScroll(v, 800); // the page-synced view's own scroll must not leak
r = show(v, 'citations', 'john/3::source');
eq(r.action, 'restore', 'citations still re-mounts across a translation detour');
eq(r.entry.scrollTop, 500, '...at its own saved offset, untouched by scroll-sync');

// ---- When scroll-sync runs at all ----
// Four inputs, all of which can move independently; the panel re-asserts this
// predicate after each of them and nowhere else.
console.log('wantsScrollSync:');
const syncable = { visible: true, scrollSync: true };
eq(P.wantsScrollSync(fresh(), syncable), true, 'a visible, expanded Translation view syncs');
eq(P.wantsScrollSync(fresh(), { visible: false, scrollSync: true }), false, 'a hidden panel does not sync');
eq(P.wantsScrollSync(fresh({ collapsed: true }), syncable), false, 'a collapsed panel does not sync');
eq(P.wantsScrollSync(fresh({ mode: 'citations' }), syncable), false, 'citations mode does not sync');
eq(P.wantsScrollSync(fresh(), { visible: true, scrollSync: false }), false, 'the setting switches it off outright');
const nonBible = fresh();
nonBible.isBible = false;
eq(P.wantsScrollSync(nonBible, syncable), false, 'a non-Bible chapter is citations, so it does not sync');
// Defensive: a missing flag must not read as "on" for visibility, nor as "off"
// for the setting (the panel asks before its first settings read resolves).
eq(P.wantsScrollSync(fresh(), {}), false, 'no visibility means no sync');
eq(P.wantsScrollSync(fresh(), { visible: true }), true, 'an unknown setting reads as its default (on)');

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

// ---- Ramp-in ----
// A re-alignment must have a visible beginning: an exponential chase is
// fastest on its first frame, which reads as being thrown. The ramp scales the
// first fraction of a second so the move accelerates in, then eases out.
console.log('easeRamp:');
const RAMP = 260;
eq(P.easeRamp(0, RAMP), 0, 'the move starts from a standstill');
check(P.easeRamp(RAMP, RAMP) === 1, 'the ramp is fully open once it has elapsed');
check(P.easeRamp(RAMP * 5, RAMP) === 1, '...and stays open after that');
check(P.easeRamp(RAMP / 2, RAMP) > 0.4 && P.easeRamp(RAMP / 2, RAMP) < 0.6, 'halfway through the ramp is about half open');
check(P.easeRamp(RAMP * 0.1, RAMP) < 0.1, 'it opens slowly at first (smoothstep, no corner)');
check(P.easeRamp(100, 0) === 1, 'no ramp configured means fully open');
check(P.easeRamp(-50, RAMP) === 0, 'a negative elapsed cannot open the ramp');

// The ramp only slows the early frames; it must never stop the move arriving.
let ramped = 0;
for (let i = 0; i < 600; i++) ramped = P.scrollStep(ramped, 1000, 16, TAU, P.easeRamp(i * 16, RAMP));
check(Math.abs(1000 - ramped) < 0.5, 'a ramped chase still converges');
check(P.scrollStep(0, 1000, 16, TAU, 0) === 0, 'a fully closed ramp holds position');
check(P.scrollStep(0, 1000, 16, TAU, 1) === P.scrollStep(0, 1000, 16, TAU), 'a fully open ramp is the plain chase');
const early = P.scrollStep(0, 1000, 16, TAU, P.easeRamp(0, RAMP));
const later = P.scrollStep(0, 1000, 16, TAU, P.easeRamp(RAMP, RAMP));
check(early < later, 'the first frame moves less than a frame at full speed');

// ---- When a re-alignment is over ----
// Getting this wrong strands the panel in "re-aligning" forever, and every
// later page scroll takes the eased path instead of tracking 1:1.
console.log('realignmentDone:');
const LIM = P.SCROLL_LIMITS; // the shipped policy, not a copy of it
const AFTER = LIM.stallAfterMs + 1;
function done(distance, moved, elapsed) {
  return P.realignmentDone({ distance, moved, elapsed }, LIM);
}
check(done(0.4, 2, AFTER) === true, 'inside the settle threshold is arrived');
check(done(-0.4, 2, AFTER) === true, '...approaching from either side');
check(done(50, 3, AFTER) === false, 'still far away and still moving: keep going');
check(done(50, 0, AFTER) === true, 'far away but no longer moving at all: the browser rounded us to a stop');
check(done(50, 0.5, AFTER) === false, 'inching along is not a stall — a step shrinks with the distance left');
check(done(50, null, 0) === false, 'the first frame has not moved yet — that is not a stall');
// The ramp deliberately makes the opening frames nearly still. Reading that as
// a stall would cancel every re-alignment on frame one — the bug this guards.
check(done(50, 0, 0) === false, 'a motionless frame during ramp-in is the ramp working, not a stall');
check(done(50, 0, LIM.stallAfterMs - 1) === false, '...right up to the end of the ramp window');
check(done(50, 0, AFTER) === true, '...and only counts once the ramp is open');
check(done(50, 3, LIM.maxMs) === true, 'past the cap, stop chasing whatever the distance');
check(done(50, 3, LIM.maxMs - 1) === false, '...but not one frame before it');

// ---- Scrolling on while the panel is still re-aligning ----
// The page's own movement is the panel's to mirror 1:1; only the detach gap
// eases. Carrying the body by the page's delta is what keeps the two apart —
// without it the chase trails a target that runs away from it, and the panel
// floats along behind the page for as long as the user keeps scrolling.
console.log('carryScroll:');
const MAXPX = 1000;
eq(P.carryScroll(200, 500, 560, MAXPX), 260, "the body moves exactly as far as the page's target did");
eq(P.carryScroll(560 - 300, 500, 560, MAXPX) - (560 - 300), 60, 'and the gap it is closing survives the carry untouched');
eq(P.carryScroll(200, 500, 440, MAXPX), 140, 'scrolling back up carries the same way');
eq(P.carryScroll(20, 500, 400, MAXPX), 0, 'a carry past the top clamps at the top');
eq(P.carryScroll(980, 500, 600, MAXPX), MAXPX, '...and past the bottom at the bottom');
eq(P.carryScroll(300, 500, 500, MAXPX), 300, 'a target that did not move moves nothing');

// The truth table above cannot see the frame-to-frame behaviour, which is
// where the real bug lived. Run the actual loop with the shipped constants.
//   round   store whole pixels, as the browser really does
//   page    px the page scrolls every frame, mid-re-alignment. The shell
//           carries the body along by that much and moves the mark `moved` is
//           measured from, so the gap — and only the gap — is what eases
//   max     the body's scrollable range, so a carry can hit the end of it
function realign(distance, opts) {
  const o = opts || {};
  const round = o.round === true;
  const page = Number(o.page) || 0;
  const max = o.max === undefined ? Infinity : o.max;
  let target = distance;
  let pos = 0;
  let wasAt = null;
  let started = null;
  let frames = 0;
  for (let ts = 0; ts < 20000; ts += 16) {
    if (started === null) started = ts;
    const moved = wasAt === null ? null : pos - wasAt;
    const elapsed = ts - started;
    if (P.realignmentDone({ distance: target - pos, moved, elapsed }, LIM)) {
      return { frames, ms: elapsed, snapped: Math.abs(target - pos) };
    }
    wasAt = pos;
    const ramp = P.easeRamp(elapsed, P.SCROLL_RAMP_MS);
    pos = P.floorStep(pos, P.scrollStep(pos, target, 16, P.SCROLL_TAU_MS, ramp), target, P.SCROLL_MIN_STEP_PX);
    if (round) pos = Math.round(pos); // what the browser actually stores
    if (page) {
      // The page's target is bounded by the body's own range, exactly as
      // `fraction * panelDenom` is in the shell.
      const next = Math.min(max, target + page);
      const at = pos;
      pos = P.carryScroll(at, target, next, max);
      wasAt += pos - at; // the carry was the page's travel, not the chase's
      target = next;
    }
    frames++;
  }
  return { frames, ms: 20000, snapped: Math.abs(target - pos), ranAway: true };
}

for (const d of [50, 300, 1000]) {
  const r = realign(d);
  check(!r.ranAway, `a ${d}px re-alignment terminates`);
  check(r.frames > 3, `a ${d}px re-alignment actually animates (${r.frames} frames, not an instant snap)`);
  check(r.ms < LIM.maxMs, `a ${d}px re-alignment finishes well inside the cap (${Math.round(r.ms)}ms)`);
  check(r.snapped <= LIM.settlePx, `a ${d}px re-alignment arrives rather than jumping the last stretch`);
  const rounded = realign(d, { round: true });
  check(!rounded.ranAway, `a ${d}px re-alignment terminates even when the browser rounds scrollTop`);
  check(rounded.frames > 3, `...and still animates (${rounded.frames} frames)`);
}

// Now the same loop with the user scrolling the page all the way through the
// re-alignment. The carry is what makes this indistinguishable from the still
// case: the panel matches the page 1:1 the whole time and the gap closes on its
// own schedule. Get it wrong and the panel trails the page — by roughly
// tau x velocity — until the scrolling stops.
for (const speed of [8, 40]) {
  const still = realign(300);
  const scrolling = realign(300, { page: speed });
  check(!scrolling.ranAway, `re-aligning while the page scrolls on at ${speed}px/frame still terminates`);
  eq(scrolling.frames, still.frames, `...in the same ${still.frames} frames as a still page — scrolling on cannot prolong it`);
  check(scrolling.snapped <= LIM.settlePx, '...and it arrives rather than trailing the page');
  // Whole-pixel rounding is what strands a chase, and a page scroll used to
  // blind the stall test that catches it: the carry moved the body every frame,
  // so "how far did the chase get" was never measured.
  const rounded = realign(300, { page: speed, round: true });
  check(!rounded.ranAway, `...and terminates too when the browser rounds scrollTop (${rounded.frames} frames)`);
  check(rounded.snapped <= LIM.settlePx, '...arriving rather than being cut off by the cap');
}

// The body can run out of room mid-carry (already at the bottom, page still
// scrolling). The gap then closes against the end of the range instead.
const atBottom = realign(300, { page: 40, max: 300 });
check(!atBottom.ranAway, 'a re-alignment whose carry hits the end of the body still terminates');
check(atBottom.snapped <= LIM.settlePx, '...and still arrives rather than jumping the last stretch');

// ---- Where a revealed target lands ----
// Opening a citation used to park the target at the very top of the panel, so
// the sentence leading into it was above the fold. The rule places it near the
// vertical middle instead — expressed as a fraction of the visible body, so it
// holds at any panel width or window height — and both clamp cases (a target
// too near the top or the bottom of the content to be centered) are intended
// behaviour, not an accident of clamping.
console.log('revealTop:');
const VIEW = 800;
const MAX = 5000;
function reveal(targetTop, opts) {
  return P.revealTop(Object.assign({ targetTop, viewportH: VIEW, maxScroll: MAX }, opts || {}));
}
const middle = reveal(2000);
check(2000 - middle > VIEW * 0.25, 'a revealed target has room above it for the paragraph leading in');
check(2000 - middle < VIEW * 0.6, '...and still sits near the middle rather than the bottom');
eq(reveal(2000), 2000 - VIEW * P.SCROLL_REVEAL_FRACTION, 'the gap above the target is a fraction of the visible body');
// The same target in a taller panel keeps the same *proportion*, not the same
// pixel count — the whole reason this is not a magic number.
eq(P.revealTop({ targetTop: 2000, viewportH: 1600, maxScroll: MAX }), 2000 - 1600 * P.SCROLL_REVEAL_FRACTION,
  'a taller panel leaves proportionally more context above');

// Clamp cases: "as close as possible", never a failure and never a bounce.
eq(reveal(10), 0, 'a target too near the top of the content scrolls to the top');
eq(reveal(0), 0, '...including the very first thing in the view');
eq(reveal(MAX + 500), MAX, 'a target near the end scrolls to the bottom, where it is still visible');
check(reveal(MAX) <= MAX, 'no destination past the end of the scrollable range');
eq(P.revealTop({ targetTop: 500, viewportH: VIEW, maxScroll: 0 }), 0, 'an unscrollable body stays at the top');

// The talk reader's sticky header covers the top of the body. Centering clears
// it on any ordinary panel, but that must be a floor in the rule rather than a
// happy accident of the numbers.
const HEAD = 64;
check(2000 - reveal(2000, { clearTop: HEAD }) >= HEAD, 'a centered target clears the sticky header');
eq(reveal(2000, { clearTop: HEAD }), reveal(2000), '...without the header changing where centering puts it');
// A panel shorter than about twice the header: centering would tuck the target
// under it, so the floor takes over.
const short = P.revealTop({ targetTop: 2000, viewportH: 100, maxScroll: MAX, clearTop: HEAD });
check(2000 - short >= HEAD, 'in a short panel the target is still pushed clear of the header');
check(2000 - short > 100 * P.SCROLL_REVEAL_FRACTION, '...which is further down than centering alone would put it');
// Degenerate: a panel shorter than its own header. Keeping the target on
// screen outranks keeping it clear, so the floor gives way — landing it *at*
// the bottom edge would be the same as not showing it.
const tiny = P.revealTop({ targetTop: 2000, viewportH: 40, maxScroll: MAX, clearTop: HEAD });
check(2000 - tiny < 40, 'a panel shorter than its header still keeps the target inside the body');
// The one case the floor cannot honour: no scroll position lifts content that
// is already above the fold, so the top clamp wins and the panel goes to the
// top rather than inventing a negative scroll.
eq(P.revealTop({ targetTop: 20, viewportH: VIEW, maxScroll: MAX, clearTop: HEAD }), 0,
  'a target inside the top clamp scrolls to the top — no scroll position can clear it');

// Garbage in cannot produce a garbage scroll position.
check(P.revealTop({}) === 0, 'a placement with nothing to measure is the top');
check(P.revealTop({ targetTop: -500, viewportH: VIEW, maxScroll: MAX }) === 0, 'a negative target clamps to the top');
check(P.revealTop({ targetTop: 2000, viewportH: -10, maxScroll: MAX }) === 2000, 'a nonsense viewport leaves no gap rather than a negative one');

// ---- Telling our own scroll from the user's ----
// The panel must never fight the user for the body. Every write records where
// it left the body; a 'scroll' event that doesn't match that is the user's, and
// it detaches the panel from the page until the next re-alignment.
console.log('isForeignScroll:');
check(P.isForeignScroll(300, 300) === false, "the position we just wrote is our own scroll, not the user's");
check(P.isForeignScroll(300.4, 300) === false, 'sub-pixel rounding by the browser is still our own scroll');
check(P.isForeignScroll(340, 300) === true, 'a jump away from what we wrote is the user scrolling');
check(P.isForeignScroll(260, 300) === true, '...in either direction');
check(P.isForeignScroll(0, null) === true, 'a scroll before we have written anything is the user');
check(P.isForeignScroll(0, undefined) === true, '...however that unwritten state is spelled');

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
