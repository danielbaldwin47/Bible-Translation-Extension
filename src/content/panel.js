/*
 * The side panel: builds the DOM once, exposes state renderers, wires the
 * controls (translation dropdown, collapse, close, settings), and drives the
 * proportional scroll-sync with the main page.
 *
 * IIFE -> __BTX.panel. One instance per page (content script runs once).
 */
(function (root) {
  'use strict';

  const SAN = () => root.__BTX.sanitize;

  let ui = null; // refs once built
  const cbs = {}; // event callbacks set by the orchestrator
  let scrollRaf = null;
  let scrollSyncOn = false;

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

    const body = el('div', 'btx-body');
    const footer = el('div', 'btx-footer');

    panel.appendChild(header);
    panel.appendChild(modes);
    panel.appendChild(body);
    panel.appendChild(footer);

    // Collapsed tab pinned to the right edge.
    const tab = el('button', 'btx-tab', 'Bible');
    tab.title = 'Show comparison';

    rootEl.appendChild(panel);
    rootEl.appendChild(tab);
    if (!existing) document.body.appendChild(rootEl);

    // Wire controls.
    select.addEventListener('change', () => cbs.onTranslationChange && cbs.onTranslationChange(select.value));
    gear.addEventListener('click', () => cbs.onGear && cbs.onGear());
    collapse.addEventListener('click', () => setCollapsed(true));
    close.addEventListener('click', () => cbs.onClose && cbs.onClose());
    tab.addEventListener('click', () => setCollapsed(false));
    modeTranslation.addEventListener('click', () => cbs.onModeChange && cbs.onModeChange('translation'));
    modeCitations.addEventListener('click', () => cbs.onModeChange && cbs.onModeChange('citations'));

    ui = { rootEl, panel, header, title, select, modes, modeTranslation, modeCitations, body, footer, tab };
    return ui;
  }

  function setHandlers(handlers) {
    Object.assign(cbs, handlers);
  }

  function setVisible(visible) {
    ensureRoot();
    ui.rootEl.style.display = visible ? '' : 'none';
  }

  function setCollapsed(collapsed) {
    ensureRoot();
    ui.rootEl.classList.toggle('btx-collapsed', collapsed);
    if (collapsed) detachScrollSync();
    else attachScrollSync();
  }

  function isCollapsed() {
    return ui && ui.rootEl.classList.contains('btx-collapsed');
  }

  function setTitle(text) {
    ensureRoot();
    ui.title.textContent = text;
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

  function clearBody() {
    ensureRoot();
    ui.body.textContent = '';
    ui.footer.textContent = '';
  }

  function renderLoading(label) {
    clearBody();
    const wrap = el('div', 'btx-state btx-loading');
    wrap.appendChild(el('div', 'btx-spinner'));
    wrap.appendChild(el('div', 'btx-state-text', label ? `Loading ${label}…` : 'Loading…'));
    ui.body.appendChild(wrap);
  }

  function renderNoKey() {
    clearBody();
    const wrap = el('div', 'btx-state');
    wrap.appendChild(el('p', 'btx-state-text', 'Add a free scripture.api.bible API key to load translations.'));
    const btn = el('button', 'btx-cta', 'Add your API key');
    btn.addEventListener('click', () => cbs.onGear && cbs.onGear());
    wrap.appendChild(btn);
    ui.body.appendChild(wrap);
  }

  function renderError(message, opts) {
    clearBody();
    const wrap = el('div', 'btx-state btx-error');
    wrap.appendChild(el('p', 'btx-state-text', message || 'Something went wrong.'));
    if (!opts || opts.retry !== false) {
      const btn = el('button', 'btx-cta', 'Retry');
      btn.addEventListener('click', () => cbs.onRetry && cbs.onRetry());
      wrap.appendChild(btn);
    }
    ui.body.appendChild(wrap);
  }

  function renderContent(payload) {
    clearBody();
    const article = el('div', 'btx-article');
    if (payload.reference) article.appendChild(el('div', 'btx-reference', payload.reference));
    article.appendChild(SAN().renderBlocks(payload.blocks));
    ui.body.appendChild(article);
    if (payload.copyright) ui.footer.textContent = payload.copyright;
    ui.body.scrollTop = 0;
    if (!isCollapsed()) attachScrollSync();
  }

  // ---- Proportional scroll-sync with the main page ----
  function syncNow() {
    if (!ui || isCollapsed()) return;
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

  function attachScrollSync() {
    if (scrollSyncOn) return;
    scrollSyncOn = true;
    window.addEventListener('scroll', onPageScroll, { passive: true });
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

  // Switch the panel between 'translation' and 'citations'. Citations mode hides
  // the translation dropdown + copyright footer and disables verse scroll-sync.
  function setMode(mode) {
    ensureRoot();
    const cit = mode === 'citations';
    ui.modeTranslation.classList.toggle('btx-active', !cit);
    ui.modeCitations.classList.toggle('btx-active', cit);
    ui.select.style.display = cit ? 'none' : '';
    ui.footer.style.display = cit ? 'none' : '';
    ui.rootEl.setAttribute('data-btx-mode', mode);
    if (cit) detachScrollSync();
  }

  root.__BTX = Object.assign(root.__BTX || {}, {
    panel: {
      ensureRoot, setHandlers, setVisible, setCollapsed, isCollapsed, setTitle,
      populateTranslations, renderLoading, renderNoKey, renderError, renderContent,
      getRootEl, getBodyEl, setMode,
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
