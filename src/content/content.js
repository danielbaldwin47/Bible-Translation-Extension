/*
 * Orchestrator (content-script entry). Wires detection -> worker -> panel:
 *  - watches SPA navigation and re-renders the matching chapter
 *  - mirrors the site theme/font into the panel and keeps it in sync
 *  - manages translation selection, loading/error/no-key states, scroll-sync
 *
 * Runs once per page. Shared modules (constants/books) and the other content
 * modules are loaded before this file via the manifest content_scripts order.
 */
(function (root) {
  'use strict';

  const C = root.__BTX.const;
  const BOOKS = root.__BTX.books;
  const detect = root.__BTX.detect;
  const theme = root.__BTX.theme;
  const panel = root.__BTX.panel;
  const citPanel = root.__BTX.citPanel;
  const talkView = root.__BTX.talkView;

  const SELECTION_KEY = 'btxSelectedTranslation';
  const MODE_KEY = 'btxPanelMode';

  let enabled = null; // { translations, defaultId, provider, hasKey }
  let selectedId = null;
  let current = null; // parsed location
  let reqToken = 0; // guards against stale responses
  let retryTimer = null;
  let userClosed = false;
  let themeDisconnect = null;
  let currentKey = null; // dedupes repeat navigation events for the same chapter
  let mode = 'translation'; // user's preferred mode on Bible chapters
  let isBibleCurrent = true; // current page has translations (OT/NT)?
  let scrollToSnippet = true; // open sources scrolled to the cited paragraph
  let citationView = 'verse'; // citations layout: 'verse' | 'source'
  let citCache = null; // { key, node, scrollTop } — preserves the citations view
  let transCache = null; // { key, node, footer, scrollTop } — preserves translation view

  // On non-Bible books there's no translation, so Citations is forced.
  function effectiveMode() {
    return isBibleCurrent ? mode : 'citations';
  }

  function getStored(key) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(key, (d) => resolve(d && d[key])); } catch (e) { resolve(undefined); }
    });
  }
  function storeMode() { try { chrome.storage.local.set({ [MODE_KEY]: mode }); } catch (e) { /* ignore */ } }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ error: { code: C.ERR.NETWORK, message: chrome.runtime.lastError.message } });
          } else {
            resolve(res);
          }
        });
      } catch (e) {
        resolve({ error: { code: C.ERR.UNKNOWN, message: String(e) } });
      }
    });
  }

  function refLabel(parsed) {
    const name = BOOKS.bookFullName(parsed.ldsBook) || parsed.ldsBook;
    return `${name} ${parsed.chapter}`;
  }

  function findTranslation(id) {
    return enabled && enabled.translations.find((t) => t.id === id);
  }

  function applyTheme() {
    theme.apply(panel.getRootEl(), theme.capture());
  }

  // The panel header matches the site's sticky toolbar height (--btx-header-h),
  // but that toolbar may not be laid out when we first render, so the height
  // reads as unknown and the bars misalign until something (a resize) re-captures
  // it. Re-apply on a short backoff until it resolves — proactively, at launch.
  function applyThemeUntilAligned(attempt) {
    applyTheme();
    if (theme.headerHeightKnown() || attempt >= 8) return;
    const delay = attempt === 0 ? 0 : Math.min(500, 50 * 2 ** (attempt - 1));
    setTimeout(() => requestAnimationFrame(() => applyThemeUntilAligned(attempt + 1)), delay);
  }

  async function loadEnabled(force) {
    if (enabled && !force) return enabled;
    enabled = await send({ type: C.MSG.GET_ENABLED_TRANSLATIONS });
    if (!enabled || enabled.error) enabled = { translations: [], defaultId: '', provider: C.PROVIDER_APIBIBLE, hasKey: false };
    return enabled;
  }

  function storeSelection(id) {
    try { chrome.storage.local.set({ [SELECTION_KEY]: id }); } catch (e) { /* ignore */ }
  }

  async function render() {
    const parsed = detect.parseLocation(location.pathname, location.search);
    current = parsed;

    if (!parsed) {
      panel.setVisible(false);
      currentKey = null;
      return;
    }
    isBibleCurrent = parsed.isBible !== false;

    // Skip spurious events (e.g. verse-anchor hashchange) for the same chapter.
    // Mode toggles re-render directly (see renderActiveMode), bypassing this.
    const key = `${parsed.collection}/${parsed.ldsBook}/${parsed.chapter}/${parsed.lang}`;
    if (key === currentKey) return;
    currentKey = key;
    citCache = null; // new chapter -> discard the cached views
    transCache = null;
    clearTimeout(retryTimer);

    panel.ensureRoot();
    if (userClosed) {
      panel.setVisible(false);
      return;
    }

    const e = await loadEnabled();

    // Respect the "English pages only" preference.
    if (e.actOnNonEngOnly !== false && parsed.lang !== 'eng') {
      panel.setVisible(false);
      return;
    }

    panel.setVisible(true);
    applyThemeUntilAligned(0);
    panel.setTitle(refLabel(parsed));
    panel.setBibleMode(isBibleCurrent);
    panel.setMode(effectiveMode());

    await renderActiveMode();
  }

  function renderActiveMode() {
    if (!current) return undefined;
    return effectiveMode() === 'citations' ? renderCitations(current) : renderTranslation();
  }

  async function renderTranslation() {
    const e = await loadEnabled();
    const list = e.translations || [];
    if (!list.length) {
      panel.populateTranslations([], '');
      if (e.provider === C.PROVIDER_APIBIBLE && !e.hasKey) panel.renderNoKey();
      else panel.renderError('No translations enabled yet. Open settings (⚙) to choose.', { retry: false });
      return;
    }
    if (!selectedId || !findTranslation(selectedId)) {
      const stored = await getStored(SELECTION_KEY);
      selectedId = (findTranslation(stored) && stored) || (findTranslation(e.defaultId) && e.defaultId) || list[0].id;
    }
    panel.populateTranslations(list, selectedId);
    // Re-attach the cached chapter (keeps scroll) instead of re-fetching.
    if (transCache && transCache.key === transKey() && transCache.node) {
      panel.reattachContent(transCache.node, transCache.footer);
      const body = panel.getBodyEl();
      const top = transCache.scrollTop || 0;
      body.scrollTop = top;
      requestAnimationFrame(() => { body.scrollTop = top; });
      return;
    }
    await loadChapter();
  }

  function transKey() {
    return current ? `${citKey(current)}::${selectedId}` : null;
  }

  function saveTransScroll() {
    if (transCache) transCache.scrollTop = panel.getBodyEl().scrollTop;
  }

  function citKey(parsed) {
    return `${parsed.collection}/${parsed.ldsBook}/${parsed.chapter}`;
  }

  function saveCitScroll() {
    if (citCache) citCache.scrollTop = panel.getBodyEl().scrollTop;
  }

  async function renderCitations(parsed, focusVerse) {
    const body = panel.getBodyEl();
    const key = `${citKey(parsed)}::${citationView}`;
    // Re-attach the cached view (keeps scroll + which dropdowns are open).
    if (!focusVerse && citCache && citCache.key === key && citCache.node) {
      body.textContent = '';
      body.appendChild(citCache.node);
      const top = citCache.scrollTop || 0;
      body.scrollTop = top;
      requestAnimationFrame(() => { body.scrollTop = top; });
      return;
    }
    const node = await citPanel.render(body, {
      slug: parsed.ldsBook,
      chapter: parsed.chapter,
      fullName: BOOKS.bookFullName(parsed.ldsBook) || parsed.ldsBook,
      focusVerse,
      onOpenTalk: openTalk,
      view: citationView,
    });
    citCache = { key, node, scrollTop: 0 };
  }

  function openTalk(entry) {
    saveCitScroll(); // so "‹ Back" returns to the same spot in the list
    talkView.open(panel.getBodyEl(), {
      entry,
      source: entry.source || {},
      onBack: () => renderCitations(current),
      autoScroll: scrollToSnippet,
    });
  }

  async function loadChapter() {
    clearTimeout(retryTimer);
    const parsed = current;
    const tr = findTranslation(selectedId);
    if (!parsed || !tr) return;
    const chapterId = detect.toUsfmChapterId(parsed);
    const label = tr.abbr || tr.name;
    panel.renderLoading(label);

    const myToken = ++reqToken;
    const res = await send({
      type: C.MSG.GET_CHAPTER,
      provider: tr.provider,
      bibleId: tr.id,
      chapterId,
      ldsBook: parsed.ldsBook,
      chapter: parsed.chapter,
    });
    if (myToken !== reqToken) return; // user navigated/switched in the meantime

    if (!res || res.error) {
      handleError((res && res.error) || { code: C.ERR.UNKNOWN }, label);
      return;
    }
    const footer = res.copyright || tr.copyright || '';
    const node = panel.renderContent({
      blocks: res.blocks,
      copyright: footer,
      reference: res.reference || refLabel(parsed),
    });
    transCache = { key: transKey(), node, footer, scrollTop: 0 };
    if (res.fums) fireFums(res.fums);
  }

  function handleError(error, label) {
    switch (error.code) {
      case C.ERR.NO_KEY:
        panel.renderNoKey();
        break;
      case C.ERR.RATE_LIMITED: {
        const wait = Math.min(Math.max(error.retryAfterMs || 2000, 1000), 60000);
        panel.renderError(`Rate limited. Retrying in ${Math.ceil(wait / 1000)}s…`, { retry: false });
        retryTimer = setTimeout(loadChapter, wait);
        break;
      }
      case C.ERR.NOT_FOUND:
        panel.renderError(`${label} doesn’t have this chapter available.`, { retry: false });
        break;
      case C.ERR.INVALID_KEY:
        panel.renderError('Your API key was rejected. Open settings (⚙) to fix it.', { retry: false });
        break;
      case C.ERR.FORBIDDEN:
        panel.renderError(`Your key isn’t licensed for ${label}.`, { retry: false });
        break;
      case C.ERR.NETWORK:
        panel.renderError('Network error. Check your connection.');
        break;
      default:
        panel.renderError('Could not load this chapter.');
    }
  }

  // Best-effort FUMS usage tracking (api.bible terms). Injected into the page
  // world; silently degrades if the site CSP blocks it.
  function fireFums(fums) {
    try {
      if (fums.include) {
        const s = document.createElement('script');
        s.src = fums.include;
        s.async = true;
        (document.head || document.documentElement).appendChild(s);
      }
      if (fums.js) {
        const s2 = document.createElement('script');
        s2.textContent = fums.js;
        (document.head || document.documentElement).appendChild(s2);
        s2.remove();
      }
    } catch (e) { /* ignore */ }
  }

  function getSyncSettings() {
    return new Promise((resolve) => {
      try { chrome.storage.sync.get(C.SETTINGS_KEY, (d) => resolve((d && d[C.SETTINGS_KEY]) || {})); } catch (e) { resolve({}); }
    });
  }

  function applyWidth(px) {
    const w = Number(px);
    if (Number.isFinite(w) && w > 0) panel.setWidth(w);
  }

  async function persistWidth(px) {
    const s = await getSyncSettings();
    s.sidebarWidth = Number(px);
    try { chrome.storage.sync.set({ [C.SETTINGS_KEY]: s }); } catch (e) { /* ignore */ }
  }

  // True if two settings objects differ only in sidebarWidth (so a width change
  // doesn't trigger a full translation re-render).
  function sameExceptWidth(a, b) {
    const ax = Object.assign({}, a || {}); delete ax.sidebarWidth;
    const bx = Object.assign({}, b || {}); delete bx.sidebarWidth;
    return JSON.stringify(ax) === JSON.stringify(bx);
  }

  // ---- Wire up ----
  async function init() {
    panel.setHandlers({
      onTranslationChange: (id) => {
        selectedId = id;
        storeSelection(id);
        if (effectiveMode() === 'translation') loadChapter();
      },
      onRetry: () => loadChapter(),
      onGear: () => send({ type: C.MSG.OPEN_OPTIONS }),
      onClose: () => { userClosed = true; panel.setVisible(false); },
      onModeChange: (m) => {
        if (!isBibleCurrent) return; // toggle hidden on non-Bible books
        if (m === mode) return;
        if (effectiveMode() === 'citations') saveCitScroll(); else saveTransScroll();
        mode = m;
        storeMode();
        panel.setMode(m);
        renderActiveMode();
      },
      onResizeEnd: (px) => persistWidth(px),
    });

    mode = (await getStored(MODE_KEY)) === 'citations' ? 'citations' : 'translation';
    const initSettings = await getSyncSettings();
    if (initSettings.sidebarWidth) applyWidth(initSettings.sidebarWidth);
    scrollToSnippet = initSettings.scrollToSnippet !== false;
    citationView = initSettings.citationView === 'source' ? 'source' : 'verse';

    detect.setupNavigation(() => render());

    themeDisconnect = theme.observe(() => {
      if (current && !userClosed) applyTheme();
    });

    // Settings changed in options -> apply width live; re-render only if a
    // translation-affecting field changed.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes[C.SETTINGS_KEY]) {
        const nv = changes[C.SETTINGS_KEY].newValue || {};
        const ov = changes[C.SETTINGS_KEY].oldValue || {};
        if (nv.sidebarWidth !== ov.sidebarWidth) applyWidth(nv.sidebarWidth);
        scrollToSnippet = nv.scrollToSnippet !== false;
        citationView = nv.citationView === 'source' ? 'source' : 'verse';
        if (sameExceptWidth(ov, nv)) return;
        enabled = null;
        currentKey = null; // force a re-render with the new settings
        if (current) render();
      }
    });

    // Toolbar icon toggles the panel.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === C.MSG.TOGGLE_PANEL) {
        userClosed = !userClosed;
        if (userClosed) {
          panel.setVisible(false);
        } else {
          currentKey = null; // force re-render after re-opening
          render();
        }
      }
    });

    render();
  }

  init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
