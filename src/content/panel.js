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
 *   scrollIntoView(target, { offset, frames })  scroll the body to a node
 *                                  inside the mounted view (instant: callers
 *                                  reveal a target as part of opening a view)
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
 * position (Citations, the talk reader: saved on the way out, restored on the
 * way back) or is *page-synced* (Translation: the page scroll is the source of
 * truth, so nothing is saved and the body is placed where the page says).
 * viewRestoresScroll() is that rule, and it is why scroll-sync and
 * scroll-restore can no longer both write the same body. Every move routes
 * through setBodyScroll, which eases rather than jumps — except placement (a
 * view that just mounted has no previous position to ease from), scrollIntoView
 * reveals, and reduced motion.
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
  const PAGE_SYNCED_VIEWS = { translation: true };

  function viewRestoresScroll(name) {
    return !PAGE_SYNCED_VIEWS[name];
  }

  // Record where the mounted view was scrolled, just before swapping it out —
  // this is what makes Citations (and "< Back" out of a talk) land where the
  // user left off. A page-synced view records nothing; it is placed, not
  // restored.
  function saveViewScroll(v, scrollTop) {
    if (!viewRestoresScroll(v.active)) return;
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
  // The body never jumps: every move eases toward its target. One frame of an
  // exponential chase — the remaining distance decays with time constant `tau`,
  // so the step is proportional to how far there is left to go. Small moves
  // (following a page scroll frame by frame) resolve in about a frame and read
  // as locked to the page; a mode switch worth thousands of pixels visibly
  // eases. Retargeting mid-flight needs no special case: the next call just
  // gets a new target.
  //
  // Normalizing on elapsed `dt` rather than counting frames is what keeps 60Hz
  // and 120Hz displays feeling the same.
  //
  // While the page scrolls continuously the target moves every frame too, so
  // the chase settles into a steady trail of roughly `tau x velocity` behind
  // it — that lag *is* the smoothness, and it's the one knob: lower `tau`
  // tracks the page more tightly at the cost of a sharper jump on a mode
  // switch. (Instant moves don't come through here at all; setBodyScroll
  // short-circuits them. `tau <= 0` is only a guard against a nonsense value.)
  function scrollStep(from, target, dt, tau) {
    const f = Number(from) || 0;
    const t = Number(target) || 0;
    if (!(tau > 0)) return t; // no easing configured — land on it
    if (!(dt > 0)) return f; // no time has passed, so nothing has moved
    const k = Math.min(1, 1 - Math.exp(-dt / tau));
    return f + (t - f) * k;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createState, effectiveMode, selectMode, selectCitationView, setBible,
      createViews, saveViewScroll, selectView, keepView, settleView, dropViews,
      viewRestoresScroll, scrollStep,
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
  const PANEL_HANDLED_KEYS = ['sidebarWidth', 'citationView', 'showCitationToggle', 'panelMode', 'panelCollapsed'];

  let ui = null; // refs once built
  const cbs = {}; // event handlers set by init()
  let state = createState({});
  let views = createViews();
  let visible = false;
  let scrollRaf = null;
  let scrollSyncOn = false;
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

    const panel = el('div', 'btx-panel');
    const header = el('div', 'btx-header');
    const title = el('div', 'btx-title', 'Compare');
    const select = el('select', 'btx-select');
    select.title = 'Choose translation';

    const gear = el('button', 'btx-btn btx-gear', '⚙');
    gear.title = 'Settings';
    const collapse = el('button', 'btx-btn btx-collapse', '»');
    collapse.title = 'Collapse';
    const close = el('button', 'btx-btn btx-close', '✕');
    close.title = 'Hide panel';

    const controls = el('div', 'btx-controls');
    controls.appendChild(select);
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
      body.classList.add('btx-scrolling');
      clearTimeout(scrollFadeTimer);
      scrollFadeTimer = setTimeout(() => body.classList.remove('btx-scrolling'), 1000);
    }, { passive: true });

    ui = { rootEl, panel, header, title, select, modes, modeTranslation, modeCitations, citModes, citViewSource, citViewVerse, body, footer, tab, resize };
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
    if (changed.includes('showCitationToggle')) applyCitToggleVisible(next.showCitationToggle);
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
    if (contentStale && visible && !orchestratorWillRender) requestRender();
  }

  async function init(handlers) {
    Object.assign(cbs, handlers || {});
    ensureRoot();
    await migrateLegacyLocal();
    const s = await SETTINGS().get();
    state = createState({ mode: s.panelMode, citationView: s.citationView, collapsed: s.panelCollapsed });
    applyWidth(s.sidebarWidth);
    applyCitToggleVisible(s.showCitationToggle);
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

  const SCROLL_TAU_MS = 90; // easing time constant; larger = slower, floatier
  const SCROLL_SETTLE_PX = 0.5;
  let bodyAnim = null; // { target, raf, last } while a chase is in flight

  // Queried on every page-scroll frame, so the MediaQueryList is made once and
  // re-read (it stays live, so toggling the OS setting still takes effect).
  let reducedMotionMq;
  function reducedMotion() {
    try {
      if (reducedMotionMq === undefined) {
        reducedMotionMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      }
      return !!(reducedMotionMq && reducedMotionMq.matches);
    } catch (e) {
      return false;
    }
  }

  // The one and only assignment to the body's scroll position.
  function writeBodyScroll(px) {
    ui.body.scrollTop = px;
  }

  function maxBodyScroll() {
    return Math.max(0, ui.body.scrollHeight - ui.body.clientHeight);
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
    const target = Math.min(bodyAnim.target, maxBodyScroll());
    bodyAnim.target = target;
    if (Math.abs(target - from) < SCROLL_SETTLE_PX) {
      writeBodyScroll(target);
      stopBodyScroll();
      return;
    }
    const dt = bodyAnim.last ? Math.max(0, ts - bodyAnim.last) : 16;
    bodyAnim.last = ts;
    writeBodyScroll(scrollStep(from, target, dt, SCROLL_TAU_MS));
    bodyAnim.raf = requestAnimationFrame(stepBodyScroll);
  }

  //   animate  ease toward `top` instead of landing on it. Off for placement.
  function setBodyScroll(top, opts) {
    if (!ui) return;
    const target = Math.min(maxBodyScroll(), Math.max(0, Number(top) || 0));
    if (!(opts && opts.animate) || reducedMotion()) {
      stopBodyScroll();
      writeBodyScroll(target);
      return;
    }
    if (bodyAnim) { bodyAnim.target = target; return; } // retarget in flight
    bodyAnim = { target, last: 0, raf: requestAnimationFrame(stepBodyScroll) };
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
    const restores = viewRestoresScroll(spec.name);
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

  // Scroll the body so `target` sits `offset`px below the top. Views request
  // scrolls through here rather than writing scrollTop, so the host stays the
  // one writer — and a scroll aimed at a view that has since been swapped out
  // is dropped instead of moving whatever replaced it.
  //   frames  defer the measurement N animation frames, for layout to settle
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
      setBodyScroll(ui.body.scrollTop + delta - (o.offset || 0));
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
        // placed against the page. (No refreshScrollSync: none of its three
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
  // sits. Nothing here writes scrollTop directly — it computes a target and
  // hands it to setBodyScroll, which eases into it.
  //   animate  false when this is placement (mounting a view, expanding the
  //            panel): the body is appearing, not moving.
  function syncNow(opts) {
    if (!ui || state.collapsed) return;
    // Only the page-synced view may be moved by the page. Without this, a sync
    // firing while Citations is still mounted (the mode toggle re-asserts the
    // sync before the orchestrator swaps the view) would scroll the citation
    // list — and poison the offset it saves on its way out.
    if (viewRestoresScroll(views.active)) return;
    const doc = document.scrollingElement || document.documentElement;
    const denom = doc.scrollHeight - doc.clientHeight;
    if (denom <= 0) return;
    const fraction = Math.min(1, Math.max(0, doc.scrollTop / denom));
    const panelDenom = ui.body.scrollHeight - ui.body.clientHeight;
    if (panelDenom <= 0) return;
    const animate = !opts || opts.animate !== false;
    setBodyScroll(fraction * panelDenom, { animate });
  }

  function onPageScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      syncNow();
    });
  }

  // Scroll-sync only ever runs for a visible, expanded Translation view — the
  // one invariant, asserted after every state change that could affect it
  // (`visible`, `collapsed`, effective mode) and nowhere else.
  function refreshScrollSync() {
    const wanted = visible && !state.collapsed && effectiveMode(state) === 'translation';
    if (wanted && !scrollSyncOn) {
      scrollSyncOn = true;
      window.addEventListener('scroll', onPageScroll, { passive: true });
      // Don't wait for the user's next scroll to agree with the page. This is a
      // no-op unless the synced view is already mounted (expanding from
      // collapsed); on a mode switch the view is placed when it mounts.
      syncNow({ animate: false });
    } else if (!wanted && scrollSyncOn) {
      detachScrollSync();
    }
  }

  function detachScrollSync() {
    stopBodyScroll(); // scroll-sync is the only thing that eases; it stops here
    if (!scrollSyncOn) return;
    scrollSyncOn = false;
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
