/*
 * The side panel — a deep module that owns everything panel-shaped: its DOM,
 * its state (mode, citation layout, collapsed, width, bible-mode), the
 * persistence of that state through __BTX.settings, scroll-sync, and
 * drag-to-resize. It is also the *view host*: callers ask for a named view and
 * the panel decides whether to rebuild it or re-mount the one it cached, and
 * it is the only writer of the body's scroll position. The orchestrator
 * supplies chapter context and content; it never sequences panel setters,
 * persists panel state, or holds panel DOM.
 *
 * Interface:
 *   init(handlers)                 build the DOM, adopt persisted state, wire
 *                                  controls; must be awaited before use
 *   showChapter({ title, isBible })  make the panel visible for a chapter
 *                                  (also invalidates every cached view)
 *   hide()
 *   effectiveMode()                'translation' | 'citations' — citations is
 *                                  forced on non-Bible chapters
 *   citationView()                 'source' | 'verse'
 *   showView({ name, key, cache, render })  mount the named view; see the view
 *                                  host section below. Returns render's result.
 *   scrollIntoView(target, { clearTop, frames })  reveal a node inside the
 *                                  mounted view — near the middle of the body,
 *                                  so the text leading into it is visible, and
 *                                  clear of any sticky chrome the caller
 *                                  declares (instant: callers reveal a target
 *                                  as part of opening a view)
 *   showTranslation(state)         render a translation-mode body state into
 *                                  the mounted view:
 *                                    { kind:'loading', label }
 *                                    { kind:'nokey' }
 *                                    { kind:'error', message, retry }
 *                                    { kind:'content', blocks, copyright, reference }
 *   populateTranslations(list, selectedId)
 *   getRootEl()
 *
 * handlers: { renderMode(mode), onTranslationChange(id), onGear, onClose,
 *   onRetry }. `renderMode` fires whenever the panel invalidated its own body
 *   content (mode toggle, citation-layout toggle, a synced change from another
 *   context); the orchestrator answers by rendering that mode's content.
 *   After showChapter() the orchestrator renders the current effectiveMode()
 *   itself — showChapter never fires events.
 *
 * Body scroll has exactly one owner and one writer. Each view either *owns* its
 * position (Citations, the talk reader: restored on the way back to where it
 * was left) or is *page-synced* (Translation: the page scroll is the source of
 * truth, so it is placed where the page says instead).
 * viewRestoresScroll() is that rule, and it is why scroll-sync and
 * scroll-restore can no longer both write the same body. The `scrollSync`
 * setting is an input to it: with sync off nothing is page-synced, so
 * Translation owns its scroll like everything else — which is why every view
 * records its offset on the way out even when nothing will read it.
 *
 * Every move routes through setBodyScroll, and almost all of them are instant:
 * tracking the page 1:1 is what makes the panel feel like the browser's own
 * scrolling. Exactly one move eases — re-alignment. The user may scroll the
 * panel away from the page (`syncDetached`, detected by isForeignScroll); the
 * panel then leaves it alone until the page scrolls again, and eases it back
 * rather than snapping. Nothing else animates, and the system's reduced-motion
 * preference is deliberately not consulted: the browser scrolls this page
 * smoothly regardless, and the panel matches the browser, not the OS. A reader
 * who wants none of it turns the `scrollSync` setting off: then the page never
 * moves the body at all — no tracking and no re-alignment either.
 *
 * IIFE -> __BTX.panel (ADR-0002). The pure state core below is also exported
 * for Node (tools/validate-panel-state.js); the DOM shell is skipped there.
 */
(function (root) {
  'use strict';

  // ---- Pure state core (Node-testable) -----------------------------------
  // The panel's state machine, free of DOM: which mode is effective and what
  // each user action means. Values arrive already normalized by
  // __BTX.settings; the guards here only defend against garbage clicks.

  function createState(init) {
    return {
      mode: init.mode === 'citations' ? 'citations' : 'translation',
      citationView: init.citationView === 'verse' ? 'verse' : 'source',
      collapsed: init.collapsed === true,
      isBible: true,
    };
  }

  // Non-Bible chapters have no translation, so citations is forced there;
  // `mode` keeps the user's Bible-chapter preference untouched.
  function effectiveMode(s) {
    return s.isBible ? s.mode : 'citations';
  }

  // A mode-segment click. True when the mode changed (content must re-render);
  // false for a re-click or on non-Bible chapters, where the toggle is inert.
  function selectMode(s, m) {
    if (m !== 'citations' && m !== 'translation') return false;
    if (!s.isBible || m === s.mode) return false;
    s.mode = m;
    return true;
  }

  // A citation-layout click. Only acts while citations are showing.
  function selectCitationView(s, v) {
    if (v !== 'source' && v !== 'verse') return false;
    if (v === s.citationView) return false;
    if (effectiveMode(s) !== 'citations') return false;
    s.citationView = v;
    return true;
  }

  // A new chapter arrived. True when the *effective* mode flipped (a Bible
  // page giving way to a non-Bible one, or back).
  function setBible(s, isBible) {
    const before = effectiveMode(s);
    s.isBible = isBible !== false;
    return effectiveMode(s) !== before;
  }

  // A text-size step (the header's A− / A+ buttons), along the grid the
  // settings module defines: `bounds` is { min, max, step } read from
  // __BTX.settings, which stays the single owner of the clamp — this walks the
  // bounds it is handed and never invents its own. Returns null when the step
  // changes nothing (already at that end, no direction, no usable scale), which
  // is what disables the button *and* what keeps a spent click from writing a
  // setting that would normalize straight back to the value already stored.
  // The result is rounded because a 0.1 grid in floats is not exact (0.7 + 0.1
  // = 0.7999999999999999) and a value that differs from the same number written
  // by the options slider would register as a change that never happened.
  function stepFontScale(scale, dir, bounds) {
    if (!Number.isFinite(scale) || !Number.isFinite(dir) || dir === 0) return null;
    const { min, max, step } = bounds;
    const moved = Number((scale + dir * step).toFixed(4));
    const next = Math.max(min, Math.min(max, moved));
    return next === scale ? null : next;
  }

  // ---- Pure view-host core (Node-testable) --------------------------------
  // A *view* is a named body of panel content: 'translation', 'citations',
  // 'talk'. The host keeps at most one cached body per name, tagged with a
  // caller-supplied content key. Same name + same key => the very same DOM is
  // re-mounted (at the scroll offset it was left at, if it is a view that owns
  // its scroll — see viewRestoresScroll); a different key (another chapter,
  // another citation layout, another translation) means rebuild. Nothing
  // outside the panel decides when a body may be reused.

  function createViews() {
    return { active: null, entries: {} };
  }

  // Which views own their scroll position. Translation mode does not: there the
  // page is the source of truth and the body mirrors it (see scroll-sync
  // below), so saving and restoring an offset would be a second, competing
  // answer to "where should the body be?". Citations and the talk reader have
  // no such external driver, so they save and restore.
  //
  // With scroll-sync switched off (the `scrollSync` setting) there is no
  // external driver for Translation either — so it owns its scroll like the
  // rest, and coming back to it lands where the user left it rather than
  // wherever the page happens to point.
  const PAGE_SYNCED_VIEWS = { translation: true };

  function viewRestoresScroll(name, scrollSync) {
    if (scrollSync === false) return true;
    return !PAGE_SYNCED_VIEWS[name];
  }

  // Whether the page's scroll may move the body at all. Four inputs, each of
  // which can move on its own; the shell re-asserts this after every one of
  // them (refreshScrollSync) and nowhere else — rendering content is not a
  // state change. `visible` must be explicit; the setting defaults to on, so an
  // unknown value reads as on rather than switching the feature off.
  function wantsScrollSync(s, opts) {
    const o = opts || {};
    if (o.visible !== true) return false;
    if (s.collapsed) return false;
    if (effectiveMode(s) !== 'translation') return false;
    return o.scrollSync !== false;
  }

  // Record where the mounted view was scrolled, just before swapping it out —
  // this is what makes Citations (and "< Back" out of a talk) land where the
  // user left off. Every view records, including a page-synced one whose offset
  // nothing will read: ownership can change under a view (the `scrollSync`
  // setting), and a view that recorded nothing while page-synced would come
  // back to a `scrollTop` of 0 — the top of the chapter — rather than to where
  // the reader actually was. Recording is inert; viewRestoresScroll decides
  // whether the number is ever read.
  function saveViewScroll(v, scrollTop) {
    const e = v.active && v.entries[v.active];
    if (e) e.scrollTop = Math.max(0, Math.round(Number(scrollTop) || 0));
  }

  // Choose between re-mounting the cached body and building a fresh one, and
  // make `name` the mounted view either way. `cacheable === false` marks the
  // fresh body as throwaway (the talk reader, which re-opens from scratch).
  function selectView(v, name, key, cacheable) {
    const hit = v.entries[name];
    v.active = name;
    if (hit && hit.keep === true && hit.node && hit.key === key) return { action: 'restore', entry: hit };
    // keep starts undecided: a body earns its cache slot, it isn't given one.
    const entry = { key, node: null, scrollTop: 0, footer: '', cacheable: cacheable !== false, keep: null };
    v.entries[name] = entry;
    return { action: 'build', entry };
  }

  // The mounted view saying whether what it just rendered is worth re-mounting.
  // A finished translation chapter is; a spinner, a no-key prompt, or an error
  // is not — re-mounting one of those instead of retrying strands the user.
  function keepView(v, keep) {
    const e = v.active && v.entries[v.active];
    if (e) e.keep = keep === true;
  }

  // The render is over. A view that said nothing either way earns its slot by
  // having finished and left something behind (`produced`) — so a render that
  // bailed out after an await can never cache a blank body. One that already
  // answered keeps its answer.
  function settleView(entry, produced) {
    if (!entry.cacheable) { entry.keep = false; return; }
    if (entry.keep === null) entry.keep = produced === true;
  }

  // A new chapter invalidates every cached body at once.
  function dropViews(v) {
    v.entries = {};
    v.active = null;
  }

  // ---- Pure scroll easing (Node-testable) ---------------------------------
  // One frame of an exponential chase — the remaining distance decays with time
  // constant `tau`, so the step is proportional to how far there is left to go.
  // The one move that uses it is re-alignment, which can be worth thousands of
  // pixels and so has to be carried rather than jumped.
  //
  // Normalizing on elapsed `dt` rather than counting frames is what keeps 60Hz
  // and 120Hz displays feeling the same.
  //
  // The target is a *fixed* gap, never a moving one: a page scroll arriving
  // mid-flight is carried 1:1 instead of retargeting the chase (see
  // carryScroll), so `tau` is purely how long the gap takes to close and
  // nothing here ever trails the page. (Instant moves don't come through here
  // at all; setBodyScroll short-circuits them. `tau <= 0` is only a guard
  // against a nonsense value.)
  //   ramp  0..1 multiplier on the step, used to *start* the move gently (see
  //         easeRamp). Defaults to 1 — full exponential ease-out.
  function scrollStep(from, target, dt, tau, ramp) {
    const f = Number(from) || 0;
    const t = Number(target) || 0;
    if (!(tau > 0)) return t; // no easing configured — land on it
    if (!(dt > 0)) return f; // no time has passed, so nothing has moved
    const r = ramp === undefined ? 1 : Math.min(1, Math.max(0, Number(ramp) || 0));
    const k = Math.min(1, 1 - Math.exp(-dt / tau)) * r;
    return f + (t - f) * k;
  }

  // How much of the easing is "switched on" `elapsed` ms into a move. An
  // exponential chase is fastest on its very first frame, which is what makes a
  // long re-alignment feel like being thrown rather than carried. Ramping the
  // step in over the first fraction of a second gives the move a beginning you
  // can see: it accelerates in, then the exponential decelerates it out.
  // Smoothstep, so there is no corner at either end.
  function easeRamp(elapsed, rampMs) {
    if (!(rampMs > 0)) return 1;
    const x = Math.min(1, Math.max(0, (Number(elapsed) || 0) / rampMs));
    return x * x * (3 - 2 * x);
  }

  // A floor under the step, in the direction of travel. The browser stores
  // scrollTop in whole pixels and an exponential step is proportional to the
  // distance left, so the last handful of pixels ask for moves under half a
  // pixel: they round away to nothing and the body stops short. The stall exit
  // in realignmentDone notices and finishes the move, but *finishing* it is a
  // jump of a few pixels, and the rule here is that the body never jumps. So
  // once the chase is slower than a pixel a frame, it walks the rest at a pixel
  // a frame — about 80ms for the tail, too small to read as motion, but it
  // arrives instead of being snapped there.
  function floorStep(from, next, target, minPx) {
    const f = Number(from) || 0;
    const n = Number(next) || 0;
    const distance = (Number(target) || 0) - f;
    const min = minPx > 0 ? minPx : 0;
    if (!min || distance === 0) return n;
    const direction = distance > 0 ? 1 : -1;
    if ((n - f) * direction >= min) return n; // already moving faster than the floor
    return f + direction * Math.min(min, Math.abs(distance)); // never past the target
  }

  // Re-alignment tuning. RAMP is how long the move takes to get going (so it
  // has a visible beginning instead of snapping to full speed); TAU is how fast
  // it settles once moving. Both live here, above the DOM shell, so the
  // validator can assert the *shipped* numbers rather than a copy of them.
  const SCROLL_TAU_MS = 165;
  const SCROLL_RAMP_MS = 130;
  const SCROLL_MIN_STEP_PX = 1; // the smallest move the browser can actually store
  const SCROLL_LIMITS = {
    // Arrival, in whole pixels — and it can be this tight only because
    // floorStep guarantees at least a pixel of progress per frame, so the last
    // stretch takes frames rather than the half second an exponential tail
    // spends being invisible (during which the panel is still re-aligning
    // instead of tracking 1:1).
    settlePx: 1,
    // "Didn't move at all", not "moved a little": a step is proportional to the
    // distance left, so a larger value here would fire on the ordinary tail and
    // make every arrival a small jump. The rounding case this exists for
    // freezes the body completely, so it moves exactly 0.
    stallPx: 0.05,
    stallAfterMs: SCROLL_RAMP_MS + 32, // ...but not before the ramp is open
    maxMs: 1800, // backstop, measured from the start (see carryScroll)
  };

  // The page moved while a re-alignment is in flight. Two motions are running
  // at once and they are not the same kind: the page's own movement is the
  // panel's to mirror 1:1, and only the detach gap is what eases. So carry the
  // body along by the page's delta and leave the gap untouched — the ease keeps
  // its own schedule and finishes on time no matter how long the user keeps
  // scrolling.
  //
  // Without this the chase is aimed at a target that runs away from it, so it
  // settles into a trail of roughly `tau x velocity` behind the page for as
  // long as the scrolling continues: the panel floats along after the page
  // instead of arriving, which reads as lag rather than as smoothness.
  // The body may not have room for the whole delta (it is already at the top or
  // the bottom), so the caller measures the shift it *actually* got out of the
  // return value rather than assuming it landed.
  function carryScroll(from, prevTarget, nextTarget, max) {
    const shifted = (Number(from) || 0) + ((Number(nextTarget) || 0) - (Number(prevTarget) || 0));
    return Math.max(0, Math.min(Number(max) || 0, shifted));
  }

  // Is the re-alignment over? Three ways to be done, and two of them exist
  // because a scroll container will not simply arrive where it is sent.
  //   distance  how far is left to travel
  //   moved     how far the body actually moved last frame — not how far it was
  //             asked to. null on the first frame, which hasn't moved
  //   elapsed   ms since the re-alignment began (drives the ramp and the cap)
  //
  // The browser rounds scrollTop to whole pixels, so a chase aiming at a
  // fractional target eventually asks for sub-pixel steps that round away to
  // nothing: it stops moving while still measurably short. That is the stall
  // exit. It must stay shut until the ramp is open (`stallAfterMs`), because
  // during ramp-in the body is *meant* to be nearly still — reading that as
  // arrival would cancel the animation on its very first frame and turn every
  // re-alignment back into the teleport this whole seam exists to avoid.
  //
  // `maxMs` runs from the start, and can do so *because* of `carryScroll`: a
  // target that moves with the page no longer stretches the travel, so the gap
  // this is closing only ever shrinks. It is a hard ceiling on how long the
  // panel may stay in re-alignment — which is what guarantees it goes back to
  // tracking 1:1 however long the user keeps scrolling.
  function realignmentDone(progress, limits) {
    const p = progress || {};
    const l = limits || SCROLL_LIMITS;
    if (Math.abs(Number(p.distance) || 0) <= l.settlePx) return true;
    if ((Number(p.elapsed) || 0) >= l.maxMs) return true;
    const rampOpen = (Number(p.elapsed) || 0) >= l.stallAfterMs;
    const stalled = p.moved !== null && p.moved !== undefined && Math.abs(Number(p.moved) || 0) < l.stallPx;
    return rampOpen && stalled;
  }

  // ---- Where a revealed target lands ---------------------------------------
  // Opening a citation is a reading task, not a navigation one: the cited
  // sentence usually sits mid-paragraph, so parking it at the very top of the
  // panel hides the run-up to it and the reader has to scroll back for the
  // context they opened the thing to see. So a revealed target lands near the
  // vertical *middle* of the visible body instead, with the lead-in above it.
  //
  // The gap above is a fraction of the body's own height rather than a pixel
  // count, so it holds at any panel width or window height. Slightly above
  // centre: a citation is read forwards, so the text after it deserves the
  // larger half.
  //   targetTop  the target's distance from the top of the scrollable content
  //   viewportH  the body's visible height
  //   maxScroll  the body's scrollable range (scrollHeight - clientHeight)
  //   clearTop   px at the top of the body that must not cover the target —
  //              the talk reader's sticky header. Centring clears it on any
  //              panel taller than about 2.5x the header, but the floor is in
  //              the rule rather than left to those numbers happening to work.
  //
  // Both clamps are intended behaviour, not leftovers: a target too near the
  // start of the content scrolls to the top and sits wherever it falls (no jump
  // and no second scroll to bounce off), and one near the end scrolls to the
  // bottom, where it is still visible. This is also why the range is a
  // parameter and not the shell's business: "as close as possible" is part of
  // the placement rule, so it is decided and tested here. (setBodyScroll clamps
  // again against the *live* range, which is the same clamp a frame later.)
  //
  // A target inside the top clamp is the one case the floor cannot honour: no
  // scroll position lifts content that is already above the fold, so the panel
  // does the only thing left and goes to the top. In the talk reader that never
  // costs anything — the header is `position: sticky`, so it takes up flow at
  // the top of the content and nothing the reader can cite starts above it.
  const SCROLL_REVEAL_FRACTION = 0.4;
  const SCROLL_REVEAL_CLEAR_PX = 10; // breathing room below a sticky header

  function revealTop(pos) {
    const p = pos || {};
    const targetTop = Number(p.targetTop) || 0;
    const viewportH = Math.max(0, Number(p.viewportH) || 0);
    const maxScroll = Math.max(0, Number(p.maxScroll) || 0);
    const clear = Math.max(0, Number(p.clearTop) || 0);
    // Keeping the target on screen outranks keeping it clear: in a panel too
    // short to do both (shorter than its own header), the floor gives way
    // rather than pushing the target past the bottom edge.
    const roomForFloor = Math.max(0, viewportH - SCROLL_REVEAL_CLEAR_PX);
    const floor = clear > 0 ? Math.min(clear + SCROLL_REVEAL_CLEAR_PX, roomForFloor) : 0;
    const gap = Math.max(viewportH * SCROLL_REVEAL_FRACTION, floor);
    return Math.max(0, Math.min(maxScroll, targetTop - gap));
  }

  // Did the body move because we moved it, or because the user did? Every write
  // records the position it left behind; a 'scroll' event reporting anything
  // else is the user's own, and the panel must yield to it rather than drag the
  // body back. `expected` is null until we have written at all.
  function isForeignScroll(actual, expected, tolerance) {
    if (expected === null || expected === undefined) return true;
    const tol = tolerance > 0 ? tolerance : 1;
    return Math.abs((Number(actual) || 0) - expected) > tol;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createState, effectiveMode, selectMode, selectCitationView, setBible,
      stepFontScale,
      createViews, saveViewScroll, selectView, keepView, settleView, dropViews,
      viewRestoresScroll, wantsScrollSync,
      scrollStep, easeRamp, floorStep, carryScroll, realignmentDone, isForeignScroll,
      revealTop,
      SCROLL_TAU_MS, SCROLL_RAMP_MS, SCROLL_MIN_STEP_PX, SCROLL_LIMITS,
      SCROLL_REVEAL_FRACTION, SCROLL_REVEAL_CLEAR_PX,
    };
  }
  if (typeof document === 'undefined') return; // Node: pure core only

  // ---- DOM shell -----------------------------------------------------------

  const SAN = () => root.__BTX.sanitize;
  const SETTINGS = () => root.__BTX.settings;

  // Panel mode/collapsed used to live in these ad-hoc chrome.storage.local
  // keys; init() migrates them into the settings module once.
  const LEGACY_MODE_KEY = 'btxPanelMode';
  const LEGACY_COLLAPSED_KEY = 'btxPanelCollapsed';

  // The settings this panel handles by itself when they change. Exposed as
  // panel.HANDLED_KEYS so the orchestrator can skip its full re-render for a
  // change touching only these — one list, no mirror to drift.
  const PANEL_HANDLED_KEYS = ['sidebarWidth', 'fontScale', 'citationView', 'showCitationToggle', 'citationSourceMark', 'panelMode', 'panelCollapsed', 'scrollSync'];

  let ui = null; // refs once built
  const cbs = {}; // event handlers set by init()
  let state = createState({});
  let views = createViews();
  let visible = false;
  let scrollRaf = null;
  // The `scrollSync` setting: may the page's scroll move the body at all? An
  // input to wantsScrollSync *and* to who owns a view's scroll, so it is read
  // before the first applyModeUI and re-read on every settings change. Distinct
  // from pageScrollBound below, which is the mechanism the setting switches:
  // whether the window listener is attached right now.
  let scrollSync = true;
  // The body-text multiplier currently applied, always a normalized value (it
  // is written by applyFontScale, never assigned raw). The header's stepper
  // steps from this rather than re-reading storage, so a click is instant and
  // the disabled ends match what is on screen.
  let fontScale = 1;
  let pageScrollBound = false;
  let scrollFadeTimer = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensureRoot() {
    const existing = document.getElementById('btx-root');
    if (existing && ui) return ui;

    const rootEl = existing || el('div', null);
    rootEl.id = 'btx-root';
    rootEl.setAttribute('data-btx-theme', 'light');
    rootEl.setAttribute('data-btx-mode', 'translation');
    rootEl.setAttribute('data-btx-source-mark', 'strip');

    const panel = el('div', 'btx-panel');
    const header = el('div', 'btx-header');
    const title = el('div', 'btx-title', 'Compare');
    const select = el('select', 'btx-select');
    select.title = 'Choose translation';

    // Text-size stepper. Two buttons rather than the options page's slider
    // because the size is read-and-adjust: the reader is looking at the text
    // while stepping it. Both write the same setting the slider does.
    const smaller = el('button', 'btx-btn btx-font-step', 'A−');
    smaller.title = 'Smaller text';
    const larger = el('button', 'btx-btn btx-font-step btx-font-larger', 'A+');
    larger.title = 'Larger text';

    const gear = el('button', 'btx-btn btx-gear', '⚙');
    gear.title = 'Settings';
    const collapse = el('button', 'btx-btn btx-collapse', '»');
    collapse.title = 'Collapse';
    const close = el('button', 'btx-btn btx-close', '✕');
    close.title = 'Hide panel';

    const controls = el('div', 'btx-controls');
    controls.appendChild(select);
    controls.appendChild(smaller);
    controls.appendChild(larger);
    controls.appendChild(gear);
    controls.appendChild(collapse);
    controls.appendChild(close);

    header.appendChild(title);
    header.appendChild(controls);

    // Mode toggle: Translation | Citations
    const modes = el('div', 'btx-modes');
    const modeTranslation = el('button', 'btx-mode btx-active', 'Translation');
    const modeCitations = el('button', 'btx-mode', 'Citations');
    modes.appendChild(modeTranslation);
    modes.appendChild(modeCitations);

    // Citation-layout sub-toggle: By source | By verse (shown only in citations
    // mode; CSS-gated off data-btx-mode, hidden via .btx-cit-toggle-off setting).
    const citModes = el('div', 'btx-cit-modes');
    const citViewSource = el('button', 'btx-cit-mode btx-active', 'By source');
    const citViewVerse = el('button', 'btx-cit-mode', 'By verse');
    citModes.appendChild(citViewSource);
    citModes.appendChild(citViewVerse);

    const body = el('div', 'btx-body');
    const footer = el('div', 'btx-footer');

    // Drag-to-resize grip on the panel's left (inner) edge.
    const resize = el('div', 'btx-resize');
    resize.title = 'Drag to resize';

    panel.appendChild(resize);
    panel.appendChild(header);
    panel.appendChild(modes);
    panel.appendChild(citModes);
    panel.appendChild(body);
    panel.appendChild(footer);

    // Collapsed tab pinned to the right edge.
    const tab = el('button', 'btx-tab', 'Translation & Citations');
    tab.title = 'Show panel';

    rootEl.appendChild(panel);
    rootEl.appendChild(tab);
    if (!existing) {
      rootEl.style.display = 'none'; // stay hidden until showChapter()
      document.body.appendChild(rootEl);
      window.addEventListener('resize', updatePageReserve, { passive: true });
    }

    // Wire controls.
    select.addEventListener('change', () => cbs.onTranslationChange && cbs.onTranslationChange(select.value));
    smaller.addEventListener('click', () => onFontStep(-1));
    larger.addEventListener('click', () => onFontStep(1));
    gear.addEventListener('click', () => cbs.onGear && cbs.onGear());
    close.addEventListener('click', () => cbs.onClose && cbs.onClose());
    collapse.addEventListener('click', () => setCollapsed(true));
    tab.addEventListener('click', () => setCollapsed(false));
    modeTranslation.addEventListener('click', () => onModeClick('translation'));
    modeCitations.addEventListener('click', () => onModeClick('citations'));
    citViewSource.addEventListener('click', () => onCitViewClick('source'));
    citViewVerse.addEventListener('click', () => onCitViewClick('verse'));
    resize.addEventListener('pointerdown', onResizeDown);
    // Show the scrollbar while scrolling, fade it ~1s after it stops.
    body.addEventListener('scroll', () => {
      onBodyScrolled();
      body.classList.add('btx-scrolling');
      clearTimeout(scrollFadeTimer);
      scrollFadeTimer = setTimeout(() => body.classList.remove('btx-scrolling'), 1000);
    }, { passive: true });

    ui = { rootEl, panel, header, title, select, smaller, larger, modes, modeTranslation, modeCitations, citModes, citViewSource, citViewVerse, body, footer, tab, resize };
    return ui;
  }

  // ---- State -> DOM --------------------------------------------------------

  function applyModeUI() {
    const cit = effectiveMode(state) === 'citations';
    ui.modeTranslation.classList.toggle('btx-active', !cit);
    ui.modeCitations.classList.toggle('btx-active', cit);
    ui.select.style.display = cit ? 'none' : '';
    ui.footer.style.display = cit ? 'none' : '';
    ui.rootEl.setAttribute('data-btx-mode', cit ? 'citations' : 'translation');
    refreshScrollSync();
  }

  function applyCitationViewUI() {
    const verse = state.citationView === 'verse';
    ui.citViewVerse.classList.toggle('btx-active', verse);
    ui.citViewSource.classList.toggle('btx-active', !verse);
  }

  function applyCollapsedUI() {
    ui.rootEl.classList.toggle('btx-collapsed', state.collapsed);
    refreshScrollSync();
    updatePageReserve();
  }

  // Settings: whether the citation-layout sub-toggle is shown at all.
  function applyCitToggleVisible(on) {
    ui.rootEl.classList.toggle('btx-cit-toggle-off', on === false);
  }

  // Settings: how a citation row marks its source type (acronym chip vs. a
  // coloured group edge). Pure CSS off the root attribute — the citation DOM
  // carries both hooks whichever is chosen, so no re-render.
  function applyCitSourceMark(mark) {
    ui.rootEl.setAttribute('data-btx-source-mark', mark === 'chip' ? 'chip' : 'strip');
  }

  // The reader's text-size multiplier. It is a *second* variable rather than a
  // pre-multiplied size because theme.js owns --btx-size and rewrites it
  // whenever the site's own font-size changes: the two compose in CSS
  // (--btx-body-size), so neither write can clobber the other and a theme
  // re-apply that captured the same site size still writes nothing.
  function applyFontScale(scale) {
    // Through the module's own normalizer, not a second clamp here: a bad value
    // would otherwise reach the CSS var and take the whole body's font-size
    // down with it (unlike clampWidth, which exists for raw drag pixels).
    const safe = SETTINGS().normalize({ fontScale: scale }).fontScale;
    fontScale = safe; // the applied value, and what the header steps from
    ui.rootEl.style.setProperty('--btx-size-scale', String(safe));
    applyFontStepUI();
  }

  // The grid the header's stepper walks. Read from the settings module every
  // time rather than captured, so the bounds have exactly one owner.
  function fontScaleBounds() {
    const S = SETTINGS();
    return { min: S.FONT_SCALE_MIN, max: S.FONT_SCALE_MAX, step: S.FONT_SCALE_STEP };
  }

  // A stepper button is spent when its direction would change nothing — the
  // same rule that decides where a click lands, so the disabled state cannot
  // disagree with what a click would do.
  function applyFontStepUI() {
    const bounds = fontScaleBounds();
    ui.smaller.disabled = stepFontScale(fontScale, -1, bounds) === null;
    ui.larger.disabled = stepFontScale(fontScale, 1, bounds) === null;
  }

  function persist(partial) {
    try { SETTINGS().patch(partial); } catch (e) { /* storage unavailable — state still applied */ }
  }

  function requestRender() {
    cbs.renderMode && cbs.renderMode(effectiveMode(state));
  }

  // ---- User actions --------------------------------------------------------

  function onModeClick(m) {
    if (!selectMode(state, m)) return;
    applyModeUI();
    persist({ panelMode: state.mode });
    requestRender();
  }

  function onCitViewClick(v) {
    if (!selectCitationView(state, v)) return;
    applyCitationViewUI();
    persist({ citationView: state.citationView });
    requestRender();
  }

  // A− / A+. Applied first so the text resizes on the click, then persisted:
  // the write is a normal settings patch, so it carries the panel's own-write
  // tag (onSettingsChange skips re-applying it) and an open options form adopts
  // the new value through its own subscription. Body text only — nothing here
  // re-renders, the CSS vars do the work.
  function onFontStep(dir) {
    const next = stepFontScale(fontScale, dir, fontScaleBounds());
    if (next === null) return; // spent end: no write, no echo
    applyFontScale(next);
    persist({ fontScale: fontScale }); // the applied (normalized) value, not the raw step
  }

  function setCollapsed(collapsed) {
    const c = collapsed === true;
    if (state.collapsed === c) return;
    state.collapsed = c;
    applyCollapsedUI();
    persist({ panelCollapsed: c });
  }

  // ---- Lifecycle -----------------------------------------------------------

  // One-time migration of the legacy chrome.storage.local keys into the
  // settings module. Resolves once the settings hold the migrated values.
  function migrateLegacyLocal() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      try {
        chrome.storage.local.get([LEGACY_MODE_KEY, LEGACY_COLLAPSED_KEY], async (d) => {
          try {
            const partial = {};
            if (d && d[LEGACY_MODE_KEY] !== undefined) partial.panelMode = d[LEGACY_MODE_KEY];
            if (d && d[LEGACY_COLLAPSED_KEY] !== undefined) partial.panelCollapsed = d[LEGACY_COLLAPSED_KEY];
            if (Object.keys(partial).length) {
              await SETTINGS().patch(partial); // normalizes any legacy garbage
              chrome.storage.local.remove([LEGACY_MODE_KEY, LEGACY_COLLAPSED_KEY], finish);
              return;
            }
          } catch (e) { /* fall through */ }
          finish();
        });
      } catch (e) { finish(); }
    });
  }

  // Another context (options page, a synced machine, or our own patch echo)
  // changed the settings. Width and sub-toggle visibility are pure appearance
  // — always applied. State we already applied before persisting is skipped
  // via `own`; a genuinely external state change is adopted and, if it makes
  // the mounted content stale, triggers a re-render.
  function onSettingsChange({ next, changed, own }) {
    if (changed.includes('sidebarWidth')) applyWidth(next.sidebarWidth);
    if (changed.includes('fontScale')) applyFontScale(next.fontScale);
    if (changed.includes('showCitationToggle')) applyCitToggleVisible(next.showCitationToggle);
    if (changed.includes('citationSourceMark')) applyCitSourceMark(next.citationSourceMark);
    if (own) return;
    // When the same write also moved a key the panel doesn't handle, the
    // orchestrator's own settings subscriber will do a full re-render — firing
    // renderMode too would race two renders into the same body.
    const orchestratorWillRender = changed.some((k) => !PANEL_HANDLED_KEYS.includes(k));
    let contentStale = false;
    if (changed.includes('citationView') && next.citationView !== state.citationView) {
      state.citationView = next.citationView;
      applyCitationViewUI();
      if (effectiveMode(state) === 'citations') contentStale = true;
    }
    if (changed.includes('panelMode') && next.panelMode !== state.mode) {
      const before = effectiveMode(state);
      state.mode = next.panelMode;
      applyModeUI();
      if (effectiveMode(state) !== before) contentStale = true;
    }
    if (changed.includes('panelCollapsed') && next.panelCollapsed !== state.collapsed) {
      state.collapsed = next.panelCollapsed;
      applyCollapsedUI();
    }
    // Switching sync off leaves the body exactly where it is and stops the page
    // reaching it; switching it back on re-asserts the predicate, and attaching
    // syncs immediately rather than waiting for the user's next page scroll.
    // Content is unaffected either way — this changes who moves the body, not
    // what is in it.
    if (changed.includes('scrollSync') && next.scrollSync !== scrollSync) {
      scrollSync = next.scrollSync;
      refreshScrollSync(); // one of the predicate's four inputs just moved
    }
    if (contentStale && visible && !orchestratorWillRender) requestRender();
  }

  async function init(handlers) {
    Object.assign(cbs, handlers || {});
    ensureRoot();
    await migrateLegacyLocal();
    const s = await SETTINGS().get();
    state = createState({ mode: s.panelMode, citationView: s.citationView, collapsed: s.panelCollapsed });
    scrollSync = s.scrollSync; // before applyModeUI: it asserts the sync predicate
    applyWidth(s.sidebarWidth);
    applyFontScale(s.fontScale);
    applyCitToggleVisible(s.showCitationToggle);
    applyCitSourceMark(s.citationSourceMark);
    applyModeUI();
    applyCitationViewUI();
    applyCollapsedUI();
    SETTINGS().subscribe(onSettingsChange);
  }

  function showChapter(ctx) {
    ensureRoot();
    stopBodyScroll(); // a chase aimed at the outgoing chapter dies with it
    dropViews(views); // a different chapter — nothing cached still applies
    visible = true;
    ui.rootEl.style.display = '';
    ui.title.textContent = (ctx && ctx.title) || '';
    setBible(state, ctx && ctx.isBible);
    ui.modes.style.display = state.isBible ? '' : 'none';
    ui.tab.textContent = state.isBible ? 'Translation & Citations' : 'Citations';
    applyModeUI();
    updatePageReserve();
  }

  function hide() {
    if (!ui) return;
    visible = false;
    ui.rootEl.style.display = 'none';
    refreshScrollSync(); // `visible` just moved — one of the predicate's inputs
    updatePageReserve();
  }

  // ---- The body's scroll position -------------------------------------------
  // Every move of .btx-body's scrollTop goes through here: scroll-sync, view
  // placement, restore, and scrollIntoView. That is what makes "the panel is
  // the only writer" checkable rather than aspirational, and it is where the
  // no-snap rule lives — a move eases unless it is *placement* (a view that
  // just mounted, so there is no previous position to ease from) or the user
  // asked the system for reduced motion.

  const SCROLL_OWN_PX = 1; // slack for the browser's own sub-pixel rounding
  // { target, raf, last, started, wasAt } while re-aligning
  let bodyAnim = null;
  let lastWrittenTop = null; // where our last write left the body
  // True once the user has scrolled the panel away from the page's position.
  // While detached the panel keeps whatever position the user gave it; the next
  // page scroll eases it back, and that is the only animation in the module.
  let syncDetached = false;

  // The one and only assignment to the body's scroll position. Reads the value
  // back rather than trusting what we asked for: the browser clamps to the
  // scrollable range, and the clamped number is what the resulting 'scroll'
  // event will report, so it is what tells our own writes from the user's.
  function writeBodyScroll(px) {
    ui.body.scrollTop = px;
    lastWrittenTop = ui.body.scrollTop;
  }

  // The user scrolled the panel themselves. Stop fighting them: drop any
  // in-flight re-alignment and leave the body where they put it.
  function onBodyScrolled() {
    if (!ui || !isForeignScroll(ui.body.scrollTop, lastWrittenTop, SCROLL_OWN_PX)) return;
    stopBodyScroll();
    syncDetached = true;
  }

  function maxBodyScroll() {
    return Math.max(0, ui.body.scrollHeight - ui.body.clientHeight);
  }

  // The one place the body's scrollable range is applied.
  function clampToBody(px) {
    return Math.max(0, Math.min(maxBodyScroll(), Number(px) || 0));
  }

  function stopBodyScroll() {
    if (!bodyAnim) return;
    cancelAnimationFrame(bodyAnim.raf);
    bodyAnim = null;
  }

  // Read the live position each frame rather than integrating our own: the
  // browser may clamp it (content shorter than we thought) and the user may
  // scroll the body by hand mid-flight. Either way the chase continues from
  // where the body actually is.
  function stepBodyScroll(ts) {
    if (!ui || !bodyAnim) return;
    const from = ui.body.scrollTop;
    // Re-clamp every frame, not just at the start: if the body shrinks while
    // we're chasing (a render finishing, a filter hiding rows), a target past
    // the new bottom is one the browser will never let us reach — and the
    // settle test would never pass, leaving the rAF loop running forever.
    // Clamp for *this frame* only: `bodyAnim.target` stays the position the page
    // asked for, so the next carry can still subtract two figures in the same
    // coordinates. Writing the clamp back would make that difference something
    // other than how far the page moved, and the carry would apply it.
    const target = clampToBody(bodyAnim.target);
    if (!bodyAnim.started) bodyAnim.started = ts;
    // How far the body actually travelled last frame — not how far we asked it
    // to. The difference is the whole point: see realignmentDone.
    const moved = bodyAnim.wasAt === null ? null : from - bodyAnim.wasAt;
    if (realignmentDone({
      distance: target - from,
      moved,
      elapsed: ts - bodyAnim.started,
    }, SCROLL_LIMITS)) {
      writeBodyScroll(target);
      stopBodyScroll();
      syncDetached = false; // caught up with the page — track it 1:1 again
      return;
    }
    const dt = bodyAnim.last ? Math.max(0, ts - bodyAnim.last) : 16;
    bodyAnim.last = ts;
    bodyAnim.wasAt = from;
    const ramp = easeRamp(ts - bodyAnim.started, SCROLL_RAMP_MS);
    const eased = scrollStep(from, target, dt, SCROLL_TAU_MS, ramp);
    writeBodyScroll(floorStep(from, eased, target, SCROLL_MIN_STEP_PX));
    bodyAnim.raf = requestAnimationFrame(stepBodyScroll);
  }

  //   animate  ease toward `top` instead of landing on it. Only scroll-sync's
  //            re-alignment sets it; nothing else in the panel animates.
  function setBodyScroll(top, opts) {
    if (!ui) return;
    const target = clampToBody(top);
    if (!(opts && opts.animate)) {
      stopBodyScroll();
      writeBodyScroll(target);
      return;
    }
    // The target moved while we're re-aligning — the page scrolled again. Carry
    // the body the same distance right now (1:1, no easing) and the gap the
    // chase is closing is unchanged, so it keeps both its ramp and its
    // schedule. Anything else leaves the panel trailing the page for as long as
    // the scrolling lasts.
    if (bodyAnim) {
      if (target !== bodyAnim.target) {
        const at = ui.body.scrollTop;
        const to = carryScroll(at, bodyAnim.target, target, maxBodyScroll());
        writeBodyScroll(to);
        // Move the mark the stall test measures from by however much of the
        // carry the body actually took (it may have been at the top or bottom),
        // so `moved` next frame is still the chase's own travel and nothing
        // else. Dropping the mark instead would blind the stall test for the
        // whole gesture — a page scroll carries on nearly every frame — and the
        // sub-pixel stranding it exists to catch would be back.
        if (bodyAnim.wasAt !== null) bodyAnim.wasAt += to - at;
        bodyAnim.target = target;
      }
      return;
    }
    bodyAnim = { target, last: 0, started: 0, wasAt: null, raf: requestAnimationFrame(stepBodyScroll) };
  }

  // ---- View host -------------------------------------------------------------
  // The body holds exactly one view container at a time. Callers never receive
  // or hand back DOM: they name a view and describe how to build it, and the
  // host decides between building and re-mounting what it already has.

  function mountView(entry) {
    stopBodyScroll(); // a chase aimed at the outgoing view must not survive it
    ui.body.textContent = '';
    ui.body.appendChild(entry.node);
    ui.footer.textContent = entry.footer || '';
  }

  // Position a view that has just mounted, twice: once now and once next frame.
  // A freshly mounted body can still be reflowing (web fonts, re-applied
  // highlights, a translation still growing) when the first pass lands, and its
  // scroll height is what both callers below measure against. The second pass
  // is skipped if the view was swapped out again in between.
  function placeOnMount(node, apply) {
    apply();
    afterFrames(1, () => {
      if (ui && node && ui.body.contains(node)) apply();
    });
  }

  // A scroll-owning view comes back to the offset it was left at.
  function restoreScroll(entry) {
    placeOnMount(entry.node, () => setBodyScroll(entry.scrollTop));
  }

  // A page-synced view has no saved offset: it is placed where the page
  // currently sits. Instant — the content is appearing for the first time, so
  // there is nothing to ease from.
  function placeSyncedView(node) {
    placeOnMount(node, () => syncNow({ animate: false }));
  }

  // Mount the named view.
  //   name    'translation' | 'citations' | 'talk' — one cache slot each
  //   key     content identity; a different key rebuilds
  //   cache   false for a view that must never be re-mounted (the talk reader)
  //   render(node)  fills the fresh container; may be async. Called only on a
  //                 rebuild, and only after the container is in the document.
  // Returns render's result (so callers can await it), or undefined on a hit.
  function showView(spec) {
    ensureRoot();
    saveViewScroll(views, ui.body.scrollTop);
    const { action, entry } = selectView(views, spec.name, spec.key, spec.cache);
    const restores = viewRestoresScroll(spec.name, scrollSync);
    if (action === 'restore') {
      mountView(entry);
      if (restores) restoreScroll(entry);
      else placeSyncedView(entry.node);
      return undefined;
    }
    entry.node = el('div', 'btx-view');
    mountView(entry);
    setBodyScroll(0);
    // A page-synced view is placed once it has content — see showTranslation.
    // A slow render whose view was swapped out meanwhile writes into a detached
    // container — it can no longer paint over whatever replaced it, and it only
    // caches what it actually left behind (see settleView).
    const settle = (ok) => settleView(entry, ok && entry.node.childElementCount > 0);
    const out = spec.render ? spec.render(entry.node) : undefined;
    if (out && typeof out.then === 'function') {
      return out.then(
        (r) => { settle(true); return r; },
        (err) => { settle(false); throw err; },
      );
    }
    settle(true);
    return out;
  }

  // The container the mounted view renders into. Falls back to the body itself
  // so a stray call before any showView still shows something.
  function viewNode() {
    const e = views.active && views.entries[views.active];
    return (e && e.node) || ui.body;
  }

  function afterFrames(n, fn) {
    if (!(n > 0)) { fn(); return; }
    requestAnimationFrame(() => afterFrames(n - 1, fn));
  }

  // Scroll the body so `target` is readable *in context* — see revealTop for
  // where it lands and why. Views request scrolls through here rather than
  // writing scrollTop, so the host stays the one writer — and a scroll aimed at
  // a view that has since been swapped out is dropped instead of moving
  // whatever replaced it.
  //   clearTop  px of sticky chrome at the top of the body that must not cover
  //             the target (the talk reader's header)
  //   frames    defer the measurement N animation frames, for layout to settle
  //
  // Instant, not eased: every caller reveals its target as part of opening the
  // view (the talk reader's cited passage, the citations focus verse), so the
  // target should already be on screen when the view first paints — easing
  // there would mean watching the panel scroll through content the user never
  // asked to see.
  function scrollIntoView(target, opts) {
    const o = opts || {};
    afterFrames(o.frames || 0, () => {
      if (!ui || !target || !ui.body.contains(target)) return;
      const delta = target.getBoundingClientRect().top - ui.body.getBoundingClientRect().top;
      setBodyScroll(revealTop({
        targetTop: ui.body.scrollTop + delta,
        viewportH: ui.body.clientHeight,
        maxScroll: maxBodyScroll(),
        clearTop: o.clearTop,
      }));
    });
  }

  // ---- Body content (translation mode) --------------------------------------

  // The footer (copyright line) belongs to the view, so it comes back with it.
  function setFooter(text) {
    const e = views.active && views.entries[views.active];
    if (e) e.footer = text || '';
    ui.footer.textContent = text || '';
  }

  function clearBody() {
    viewNode().textContent = '';
    setFooter('');
  }

  function showTranslation(st) {
    ensureRoot();
    const host = viewNode();
    switch (st && st.kind) {
      case 'loading': {
        clearBody();
        keepView(views, false);
        const wrap = el('div', 'btx-state btx-loading');
        wrap.appendChild(el('div', 'btx-spinner'));
        wrap.appendChild(el('div', 'btx-state-text', st.label ? `Loading ${st.label}…` : 'Loading…'));
        host.appendChild(wrap);
        return;
      }
      case 'nokey': {
        clearBody();
        keepView(views, false);
        const wrap = el('div', 'btx-state');
        wrap.appendChild(el('p', 'btx-state-text', 'Add a free scripture.api.bible API key to load translations.'));
        const btn = el('button', 'btx-cta', 'Add your API key');
        btn.addEventListener('click', () => cbs.onGear && cbs.onGear());
        wrap.appendChild(btn);
        host.appendChild(wrap);
        return;
      }
      case 'error': {
        clearBody();
        keepView(views, false);
        const wrap = el('div', 'btx-state btx-error');
        wrap.appendChild(el('p', 'btx-state-text', st.message || 'Something went wrong.'));
        if (st.retry !== false) {
          const btn = el('button', 'btx-cta', 'Retry');
          btn.addEventListener('click', () => cbs.onRetry && cbs.onRetry());
          wrap.appendChild(btn);
        }
        host.appendChild(wrap);
        return;
      }
      case 'content': {
        clearBody();
        const article = el('div', 'btx-article');
        if (st.reference) article.appendChild(el('div', 'btx-reference', st.reference));
        article.appendChild(SAN().renderBlocks(st.blocks));
        host.appendChild(article);
        if (st.copyright) setFooter(st.copyright);
        keepView(views, true); // a loaded chapter is worth re-mounting
        // The chapter is only now measurable, so this is where the view gets
        // placed against the page. A no-op when the setting is off: syncNow
        // won't move a view that owns its scroll, and with sync off Translation
        // does — showView already put it at the top (fresh) or at the offset it
        // was left at (re-mounted). (No refreshScrollSync: none of its four
        // inputs moved — rendering content is not a state change.)
        placeSyncedView(viewNode());
      }
    }
  }

  function populateTranslations(list, selectedId) {
    ensureRoot();
    ui.select.textContent = '';
    if (!list || !list.length) {
      const opt = el('option', null, 'No translations');
      opt.value = '';
      ui.select.appendChild(opt);
      ui.select.disabled = true;
      return;
    }
    ui.select.disabled = false;
    for (const t of list) {
      const opt = el('option', null, t.abbr ? `${t.abbr} — ${t.name}` : t.name);
      opt.value = t.id;
      ui.select.appendChild(opt);
    }
    if (selectedId) ui.select.value = selectedId;
  }

  // ---- Page reserve ----------------------------------------------------------
  // Reserve right-edge page space equal to the (expanded) panel width by adding a
  // margin to <html>, so the site's own right-docked UI (e.g. the footnote panel)
  // lays out to the LEFT of our panel instead of being hidden behind it. Our panel
  // is position:fixed, so it's unaffected by this margin.
  function updatePageReserve() {
    if (!ui) return;
    // On narrow viewports the panel is a full-width bottom sheet — never reserve
    // horizontal space there (it would push the page off-screen).
    const narrow = window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
    const shown = ui.rootEl.style.display !== 'none';
    const reserve = !narrow && shown && !state.collapsed ? ui.rootEl.getBoundingClientRect().width : 0;
    try { document.documentElement.style.marginRight = reserve ? reserve + 'px' : ''; } catch (e) { /* ignore */ }
  }

  // ---- Proportional scroll-sync with the main page ----
  // In Translation mode the page is the source of truth for where the body
  // sits, and the panel tracks it *instantly* — one write per page-scroll
  // frame, no easing — so following the page feels exactly like the browser's
  // own scrolling rather than like something chasing it.
  //
  // Easing appears in exactly one situation: the user has scrolled the panel
  // away from the page's position (`syncDetached`), and then scrolls the page
  // again. That is a real jump — the body has to travel from where the user
  // left it back to where the page now points — so it eases instead of
  // teleporting. Once it arrives, tracking is 1:1 again.
  //
  // Scrolling on through that re-alignment does not prolong it: the page's part
  // of the movement is handed to the body immediately (carryScroll) and only
  // the gap eases, on a schedule the page can't stretch.
  //   animate  force it off for placement (mounting a view, expanding the
  //            panel): the body is appearing, not moving.
  function syncNow(opts) {
    if (!ui || state.collapsed) return;
    // Only the page-synced view may be moved by the page. Without this, a sync
    // firing while Citations is still mounted (the mode toggle re-asserts the
    // sync before the orchestrator swaps the view) would scroll the citation
    // list — and poison the offset it saves on its way out.
    if (viewRestoresScroll(views.active, scrollSync)) return;
    const doc = document.scrollingElement || document.documentElement;
    const denom = doc.scrollHeight - doc.clientHeight;
    if (denom <= 0) return;
    const fraction = Math.min(1, Math.max(0, doc.scrollTop / denom));
    const panelDenom = ui.body.scrollHeight - ui.body.clientHeight;
    if (panelDenom <= 0) return;
    const placing = opts && opts.animate === false;
    setBodyScroll(fraction * panelDenom, { animate: syncDetached && !placing });
    if (placing) syncDetached = false; // a placed view starts in agreement
  }

  function onPageScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      syncNow();
    });
  }

  // Scroll-sync only ever runs for a visible, expanded Translation view whose
  // user hasn't switched it off — the one invariant, asserted after every state
  // change that could affect it (`visible`, `collapsed`, effective mode, the
  // `scrollSync` setting) and nowhere else.
  function refreshScrollSync() {
    const wanted = wantsScrollSync(state, { visible, scrollSync });
    if (wanted && !pageScrollBound) {
      pageScrollBound = true;
      window.addEventListener('scroll', onPageScroll, { passive: true });
      // Don't wait for the user's next scroll to agree with the page. This is a
      // no-op unless the synced view is already mounted (expanding from
      // collapsed); on a mode switch the view is placed when it mounts.
      syncNow({ animate: false });
    } else if (!wanted && pageScrollBound) {
      detachScrollSync();
    }
  }

  function detachScrollSync() {
    stopBodyScroll(); // scroll-sync is the only thing that eases; it stops here
    if (!pageScrollBound) return;
    pageScrollBound = false;
    window.removeEventListener('scroll', onPageScroll);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    scrollRaf = null;
  }

  function getRootEl() {
    ensureRoot();
    return ui.rootEl;
  }

  // ---- Width: settings + drag-to-resize ----
  // Bounds come from the settings module (the one source of truth); the extra
  // viewport cap is this panel's own concern.
  function clampWidth(w) {
    const S = SETTINGS();
    const max = Math.min(S.SIDEBAR_WIDTH_MAX, Math.floor(window.innerWidth * 0.9));
    return Math.max(S.SIDEBAR_WIDTH_MIN, Math.min(max, Math.round(Number(w) || 0)));
  }

  function applyWidth(px) {
    ui.rootEl.style.setProperty('--btx-width', clampWidth(px) + 'px');
    updatePageReserve();
  }

  function widthFromEvent(e) {
    return clampWidth(window.innerWidth - e.clientX);
  }

  function onResizeMove(e) {
    applyWidth(widthFromEvent(e));
  }

  function onResizeUp(e) {
    document.removeEventListener('pointermove', onResizeMove);
    ui.rootEl.classList.remove('btx-resizing');
    const w = widthFromEvent(e);
    applyWidth(w);
    persist({ sidebarWidth: w });
  }

  function onResizeDown(e) {
    if (e.button != null && e.button !== 0) return;
    ensureRoot();
    ui.rootEl.classList.add('btx-resizing');
    document.addEventListener('pointermove', onResizeMove);
    document.addEventListener('pointerup', onResizeUp, { once: true });
    e.preventDefault();
  }

  root.__BTX = Object.assign(root.__BTX || {}, {
    panel: {
      HANDLED_KEYS: PANEL_HANDLED_KEYS.slice(),
      init,
      showChapter,
      hide,
      effectiveMode: () => effectiveMode(state),
      citationView: () => state.citationView,
      showView,
      scrollIntoView,
      showTranslation,
      populateTranslations,
      getRootEl,
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
