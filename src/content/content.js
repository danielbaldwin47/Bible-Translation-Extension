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

  const SELECTION_KEY = 'btxSelectedTranslation';

  let enabled = null; // { translations, defaultId, provider, hasKey }
  let selectedId = null;
  let current = null; // parsed location
  let reqToken = 0; // guards against stale responses
  let retryTimer = null;
  let userClosed = false;
  let themeDisconnect = null;
  let currentKey = null; // dedupes repeat navigation events for the same chapter

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
    const name = BOOKS.ldsToBibleApi(parsed.ldsBook) || parsed.ldsBook;
    return `${name} ${parsed.chapter}`;
  }

  function findTranslation(id) {
    return enabled && enabled.translations.find((t) => t.id === id);
  }

  function applyTheme() {
    theme.apply(panel.getRootEl(), theme.capture());
  }

  async function loadEnabled(force) {
    if (enabled && !force) return enabled;
    enabled = await send({ type: C.MSG.GET_ENABLED_TRANSLATIONS });
    if (!enabled || enabled.error) enabled = { translations: [], defaultId: '', provider: C.PROVIDER_APIBIBLE, hasKey: false };
    return enabled;
  }

  function getStoredSelection() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(SELECTION_KEY, (d) => resolve(d && d[SELECTION_KEY]));
      } catch (e) {
        resolve(null);
      }
    });
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

    // Skip spurious events (e.g. verse-anchor hashchange) for the same chapter,
    // so we don't refetch or reset the panel scroll. Callers that need a forced
    // re-render (settings change, toolbar toggle) reset currentKey first.
    const key = `${parsed.collection}/${parsed.ldsBook}/${parsed.chapter}/${parsed.lang}`;
    if (key === currentKey) return;
    currentKey = key;
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
    applyTheme();
    panel.setTitle(refLabel(parsed));

    const list = e.translations || [];

    if (!list.length) {
      panel.populateTranslations([], '');
      if (e.provider === C.PROVIDER_APIBIBLE && !e.hasKey) panel.renderNoKey();
      else panel.renderError('No translations enabled yet. Open settings (⚙) to choose.', { retry: false });
      return;
    }

    if (!selectedId || !findTranslation(selectedId)) {
      const stored = await getStoredSelection();
      selectedId = (findTranslation(stored) && stored) || (findTranslation(e.defaultId) && e.defaultId) || list[0].id;
    }
    panel.populateTranslations(list, selectedId);
    await loadChapter();
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
    panel.renderContent({
      blocks: res.blocks,
      copyright: res.copyright || tr.copyright || '',
      reference: res.reference || refLabel(parsed),
    });
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

  // ---- Wire up ----
  function init() {
    panel.setHandlers({
      onTranslationChange: (id) => {
        selectedId = id;
        storeSelection(id);
        loadChapter();
      },
      onRetry: () => loadChapter(),
      onGear: () => send({ type: C.MSG.OPEN_OPTIONS }),
      onClose: () => { userClosed = true; panel.setVisible(false); },
    });

    detect.setupNavigation(() => render());

    themeDisconnect = theme.observe(() => {
      if (current && !userClosed) applyTheme();
    });

    // Settings changed in options -> refresh translations and re-render.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes[C.SETTINGS_KEY]) {
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
