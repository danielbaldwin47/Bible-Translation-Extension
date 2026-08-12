/*
 * The side panel — a deep module that owns everything panel-shaped: its DOM,
 * its state (mode, citation layout, collapsed, width, bible-mode), the
 * persistence of that state through __BTX.settings, scroll-sync, and
 * drag-to-resize. The orchestrator supplies chapter context and content; it
 * never sequences panel setters or persists panel state.
 *
 * Interface:
 *   init(handlers)                 build the DOM, adopt persisted state, wire
 *                                  controls; must be awaited before use
 *   showChapter({ title, isBible })  make the panel visible for a chapter
 *   hide()
 *   effectiveMode()                'translation' | 'citations' — citations is
 *                                  forced on non-Bible chapters
 *   citationView()                 'source' | 'verse'
 *   showTranslation(state)         render a translation-mode body state:
 *                                    { kind:'loading', label }
 *                                    { kind:'nokey' }
 *                                    { kind:'error', message, retry }
 *                                    { kind:'content', blocks, copyright, reference } -> node
 *                                    { kind:'restore', node, footer, scrollTop }
 *   populateTranslations(list, selectedId)
 *   getBodyEl() / getRootEl()
 *
 * handlers: { renderMode(mode), onTranslationChange(id), onGear, onClose,
 *   onRetry }. `renderMode` fires whenever the panel invalidated its own body
 *   content (mode toggle, citation-layout toggle, a synced change from another
 *   context); the orchestrator answers by rendering that mode's content.
 *   After showChapter() the orchestrator renders the current effectiveMode()
 *   itself — showChapter never fires events.
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

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createState, effectiveMode, selectMode, selectCitationView, setBible };
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
    detachScrollSync();
    updatePageReserve();
  }

  // ---- Body content (translation mode) --------------------------------------

  function clearBody() {
    ui.body.textContent = '';
    ui.footer.textContent = '';
  }

  function showTranslation(st) {
    ensureRoot();
    switch (st && st.kind) {
      case 'loading': {
        clearBody();
        const wrap = el('div', 'btx-state btx-loading');
        wrap.appendChild(el('div', 'btx-spinner'));
        wrap.appendChild(el('div', 'btx-state-text', st.label ? `Loading ${st.label}…` : 'Loading…'));
        ui.body.appendChild(wrap);
        return undefined;
      }
      case 'nokey': {
        clearBody();
        const wrap = el('div', 'btx-state');
        wrap.appendChild(el('p', 'btx-state-text', 'Add a free scripture.api.bible API key to load translations.'));
        const btn = el('button', 'btx-cta', 'Add your API key');
        btn.addEventListener('click', () => cbs.onGear && cbs.onGear());
        wrap.appendChild(btn);
        ui.body.appendChild(wrap);
        return undefined;
      }
      case 'error': {
        clearBody();
        const wrap = el('div', 'btx-state btx-error');
        wrap.appendChild(el('p', 'btx-state-text', st.message || 'Something went wrong.'));
        if (st.retry !== false) {
          const btn = el('button', 'btx-cta', 'Retry');
          btn.addEventListener('click', () => cbs.onRetry && cbs.onRetry());
          wrap.appendChild(btn);
        }
        ui.body.appendChild(wrap);
        return undefined;
      }
      case 'content': {
        clearBody();
        const article = el('div', 'btx-article');
        if (st.reference) article.appendChild(el('div', 'btx-reference', st.reference));
        article.appendChild(SAN().renderBlocks(st.blocks));
        ui.body.appendChild(article);
        if (st.copyright) ui.footer.textContent = st.copyright;
        ui.body.scrollTop = 0;
        refreshScrollSync();
        return article;
      }
      // Re-display a previously-rendered chapter node at its saved scroll
      // position (used to keep the Translation tab's place across mode toggles).
      case 'restore': {
        ui.body.textContent = '';
        ui.footer.textContent = st.footer || '';
        ui.body.appendChild(st.node);
        const top = st.scrollTop || 0;
        ui.body.scrollTop = top;
        requestAnimationFrame(() => { ui.body.scrollTop = top; });
        refreshScrollSync();
        return st.node;
      }
      default:
        return undefined;
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
  function syncNow() {
    if (!ui || state.collapsed) return;
    const doc = document.scrollingElement || document.documentElement;
    const denom = doc.scrollHeight - doc.clientHeight;
    if (denom <= 0) return;
    const fraction = Math.min(1, Math.max(0, doc.scrollTop / denom));
    const panelDenom = ui.body.scrollHeight - ui.body.clientHeight;
    if (panelDenom <= 0) return;
    ui.body.scrollTop = fraction * panelDenom;
  }

  function onPageScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      syncNow();
    });
  }

  // Scroll-sync only ever runs for a visible, expanded Translation view — the
  // one invariant, asserted after every state change that could affect it.
  function refreshScrollSync() {
    const wanted = visible && !state.collapsed && effectiveMode(state) === 'translation';
    if (wanted && !scrollSyncOn) {
      scrollSyncOn = true;
      window.addEventListener('scroll', onPageScroll, { passive: true });
    } else if (!wanted && scrollSyncOn) {
      detachScrollSync();
    }
  }

  function detachScrollSync() {
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

  function getBodyEl() {
    ensureRoot();
    return ui.body;
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
      showTranslation,
      populateTranslations,
      getBodyEl,
      getRootEl,
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
