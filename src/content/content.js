/*
 * Orchestrator (content-script entry). Detection, worker messaging, and data
 * fetching — the panel owns its own state (mode, layout, collapsed, width):
 *  - watches SPA navigation and renders the matching chapter's content
 *  - mirrors the site theme/font into the panel and keeps it in sync
 *  - manages translation selection and the loading/error/no-key states
 *  - answers the panel's renderMode event with fresh mode content
 *
 * Runs once per page. Shared modules (constants/settings/books) and the other
 * content modules are loaded before this file via the manifest content_scripts
 * order.
 */
(function (root) {
  'use strict';

  const C = root.__BTX.const;
  const SETTINGS = root.__BTX.settings;
  const BOOKS = root.__BTX.books;
  const detect = root.__BTX.detect;
  const theme = root.__BTX.theme;
  const panel = root.__BTX.panel;
  const citPanel = root.__BTX.citPanel;
  const talkView = root.__BTX.talkView;

  const SELECTION_KEY = 'btxSelectedTranslation';

  // Settings the panel reacts to by itself (owning some, displaying others,
  // e.g. showCitationToggle). A change touching only these never needs the
  // orchestrator's full re-render — the panel adopts it and fires renderMode
  // when it made the mounted content stale. The list belongs to the panel; we
  // read it rather than keeping a copy that could drift.
  const PANEL_KEYS = panel.HANDLED_KEYS;

  let enabled = null; // { translations, defaultId, provider, hasKey }
  let selectedId = null;
  let current = null; // parsed location
  let reqToken = 0; // guards against stale responses
  let retryTimer = null;
  let userClosed = false;
  let themeDisconnect = null;
  let currentKey = null; // dedupes repeat navigation events for the same chapter
  let mounted = null; // which mode's content is in the panel body right now
  let scrollToSnippet = true; // open sources scrolled to the cited paragraph
  let citCache = null; // { key, node, scrollTop } — preserves the citations view
  let transCache = null; // { key, node, footer, scrollTop } — preserves translation view

  function getStored(key) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(key, (d) => resolve(d && d[key])); } catch (e) { resolve(undefined); }
    });
  }

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
      panel.hide();
      currentKey = null;
      return;
    }

    // Skip spurious events (e.g. verse-anchor hashchange) for the same chapter.
    // Panel-initiated changes arrive via renderMode instead, bypassing this.
    const key = `${parsed.collection}/${parsed.ldsBook}/${parsed.chapter}/${parsed.lang}`;
    if (key === currentKey) return;
    currentKey = key;
    citCache = null; // new chapter -> discard the cached views
    transCache = null;
    mounted = null;
    clearTimeout(retryTimer);

    if (userClosed) {
      panel.hide();
      return;
    }

    const e = await loadEnabled();

    // Respect the "English pages only" preference.
    if (e.actOnNonEngOnly !== false && parsed.lang !== 'eng') {
      panel.hide();
      return;
    }

    panel.showChapter({ title: refLabel(parsed), isBible: parsed.isBible !== false });
    applyThemeUntilAligned(0);

    await renderActiveMode();
  }

  function renderActiveMode() {
    if (!current) return undefined;
    return panel.effectiveMode() === 'citations' ? renderCitations(current) : renderTranslation();
  }

  // The panel switched its mode or citation layout and needs fresh content:
  // remember where the outgoing view was scrolled to, then fill the new one.
  function onRenderMode() {
    if (!current) return;
    if (mounted === 'citations') saveCitScroll();
    else if (mounted === 'translation') saveTransScroll();
    renderActiveMode();
  }

  async function renderTranslation() {
    mounted = 'translation';
    const e = await loadEnabled();
    const list = e.translations || [];
    if (!list.length) {
      panel.populateTranslations([], '');
      if (e.provider === C.PROVIDER_APIBIBLE && !e.hasKey) panel.showTranslation({ kind: 'nokey' });
      else panel.showTranslation({ kind: 'error', message: 'No translations enabled yet. Open settings (⚙) to choose.', retry: false });
      return;
    }
    if (!selectedId || !findTranslation(selectedId)) {
      const stored = await getStored(SELECTION_KEY);
      selectedId = (findTranslation(stored) && stored) || (findTranslation(e.defaultId) && e.defaultId) || list[0].id;
    }
    panel.populateTranslations(list, selectedId);
    // Re-attach the cached chapter (keeps scroll) instead of re-fetching.
    if (transCache && transCache.key === transKey() && transCache.node) {
      panel.showTranslation({
        kind: 'restore',
        node: transCache.node,
        footer: transCache.footer,
        scrollTop: transCache.scrollTop || 0,
      });
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
    mounted = 'citations';
    const body = panel.getBodyEl();
    const view = panel.citationView();
    const key = `${citKey(parsed)}::${view}`;
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
      view,
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
    // A stale caller (rate-limit retry timer, translation change) must not
    // paint a translation spinner over a mounted citations view.
    if (panel.effectiveMode() !== 'translation') return;
    const parsed = current;
    const tr = findTranslation(selectedId);
    if (!parsed || !tr) return;
    const chapterId = detect.toUsfmChapterId(parsed);
    const label = tr.abbr || tr.name;
    panel.showTranslation({ kind: 'loading', label });

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
    if (panel.effectiveMode() !== 'translation') return; // user toggled to citations mid-load

    if (!res || res.error) {
      handleError((res && res.error) || { code: C.ERR.UNKNOWN }, label);
      return;
    }
    const footer = res.copyright || tr.copyright || '';
    const node = panel.showTranslation({
      kind: 'content',
      blocks: res.blocks,
      copyright: footer,
      reference: res.reference || refLabel(parsed),
    });
    transCache = { key: transKey(), node, footer, scrollTop: 0 };
    if (res.fums) fireFums(res.fums);
  }

  function showError(message, retry) {
    panel.showTranslation({ kind: 'error', message, retry });
  }

  function handleError(error, label) {
    switch (error.code) {
      case C.ERR.NO_KEY:
        panel.showTranslation({ kind: 'nokey' });
        break;
      case C.ERR.RATE_LIMITED: {
        const wait = Math.min(Math.max(error.retryAfterMs || 2000, 1000), 60000);
        showError(`Rate limited. Retrying in ${Math.ceil(wait / 1000)}s…`, false);
        retryTimer = setTimeout(loadChapter, wait);
        break;
      }
      case C.ERR.NOT_FOUND:
        showError(`${label} doesn’t have this chapter available.`, false);
        break;
      case C.ERR.INVALID_KEY:
        showError('Your API key was rejected. Open settings (⚙) to fix it.', false);
        break;
      case C.ERR.FORBIDDEN:
        showError(`Your key isn’t licensed for ${label}.`, false);
        break;
      case C.ERR.NETWORK:
        showError('Network error. Check your connection.');
        break;
      default:
        showError('Could not load this chapter.');
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

  // ---- Wire up ----
  async function init() {
    await panel.init({
      renderMode: onRenderMode,
      onTranslationChange: (id) => {
        selectedId = id;
        storeSelection(id);
        if (panel.effectiveMode() === 'translation') loadChapter();
      },
      onRetry: () => loadChapter(),
      onGear: () => send({ type: C.MSG.OPEN_OPTIONS }),
      onClose: () => { userClosed = true; panel.hide(); },
    });

    scrollToSnippet = (await SETTINGS.get()).scrollToSnippet;

    detect.setupNavigation(() => render());

    themeDisconnect = theme.observe(() => {
      if (current && !userClosed) applyTheme();
    });

    // Settings changed (options page, or another tab) -> adopt what's ours, and
    // re-render only when it wasn't our own write and something the panel
    // doesn't own by itself moved.
    SETTINGS.subscribe(({ next, changed, own }) => {
      scrollToSnippet = next.scrollToSnippet;
      if (own) return; // we already rendered the change that caused this write
      if (!changed.some((k) => !PANEL_KEYS.includes(k))) return;
      enabled = null;
      currentKey = null; // force a re-render with the new settings
      if (current) render();
    });

    // Toolbar icon toggles the panel.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === C.MSG.TOGGLE_PANEL) {
        userClosed = !userClosed;
        if (userClosed) {
          panel.hide();
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
