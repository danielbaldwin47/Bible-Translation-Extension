/*
 * Options page logic. Reads/writes settings through __BTX.settings (which owns
 * the schema, defaults and normalization — this page never coerces a stored
 * value itself), tests the api.bible key (via the worker), and lets the user
 * pick which translations to enable + the default.
 *
 * Only api.bible is supported, and the list is filtered to the copyrighted
 * versions the user added (free public-domain/CC versions are hidden).
 */
(function () {
  'use strict';

  const C = window.__BTX.const;
  const SETTINGS = window.__BTX.settings;

  const $ = (id) => document.getElementById(id);
  const els = {
    apiKey: $('apiKey'),
    toggleKey: $('toggleKey'),
    testKey: $('testKey'),
    keyStatus: $('keyStatus'),
    translationsHint: $('translationsHint'),
    translationsList: $('translationsList'),
    defaultTranslation: $('defaultTranslation'),
    actOnNonEngOnly: $('actOnNonEngOnly'),
    scrollToSnippet: $('scrollToSnippet'),
    citationView: $('citationView'),
    showCitationToggle: $('showCitationToggle'),
    sidebarWidth: $('sidebarWidth'),
    sidebarWidthOut: $('sidebarWidthOut'),
    save: $('save'),
    saveStatus: $('saveStatus'),
  };

  let available = []; // all versions the key returns: [{id, name, abbr, copyright, provider}]
  let settings = SETTINGS.defaults();

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) resolve({ error: { code: 'NETWORK', message: chrome.runtime.lastError.message } });
        else resolve(res);
      });
    });
  }

  function setStatus(elm, msg, kind) {
    elm.textContent = msg;
    elm.className = 'status' + (kind ? ' ' + kind : '');
  }

  // Show only copyrighted versions (hide free public-domain/CC ones). If that
  // leaves nothing (e.g. copyright couldn't be classified), fall back to all.
  function displayList() {
    const premium = available.filter((t) => !C.isFreeVersion(t.copyright));
    return premium.length ? premium : available;
  }

  function renderTranslations() {
    els.translationsList.textContent = '';
    if (!available.length) {
      els.translationsHint.textContent = 'Test your key to load the versions you added.';
      els.defaultTranslation.textContent = '';
      return;
    }

    const list = displayList();
    const hidden = available.length - list.length;
    els.translationsHint.textContent = hidden > 0
      ? `Showing the ${list.length} copyrighted version(s) on your key (${hidden} free public-domain hidden).`
      : 'Check the versions you want available in the dropdown.';

    const enabledIds = new Set((settings.enabledTranslations || []).map((t) => t.id));
    const hasPriorSelection = enabledIds.size > 0;

    for (const t of list) {
      // No prior selection -> check them all (these are the versions you added).
      const checked = hasPriorSelection ? enabledIds.has(t.id) : true;
      const label = document.createElement('label');
      label.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = t.id;
      cb.checked = checked;
      cb.addEventListener('change', refreshDefaultOptions);
      const span = document.createElement('span');
      span.textContent = t.abbr ? `${t.abbr} — ${t.name}` : t.name;
      label.appendChild(cb);
      label.appendChild(span);
      els.translationsList.appendChild(label);
    }
    refreshDefaultOptions();
  }

  function checkedTranslations() {
    const ids = new Set(
      Array.from(els.translationsList.querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value)
    );
    return available.filter((t) => ids.has(t.id));
  }

  function refreshDefaultOptions() {
    const checked = checkedTranslations();
    const prev = els.defaultTranslation.value || settings.defaultTranslationId;
    els.defaultTranslation.textContent = '';
    for (const t of checked) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.abbr ? `${t.abbr} — ${t.name}` : t.name;
      els.defaultTranslation.appendChild(opt);
    }
    if (checked.some((t) => t.id === prev)) els.defaultTranslation.value = prev;
  }

  async function testKey() {
    const key = els.apiKey.value.trim();
    if (!key) { setStatus(els.keyStatus, 'Enter a key first.', 'warn'); return; }
    setStatus(els.keyStatus, 'Testing…', '');
    const res = await send({ type: C.MSG.LIST_BIBLES, key });
    if (res.error) {
      const msg = res.error.code === C.ERR.INVALID_KEY ? 'Invalid key.' : `Error: ${res.error.message || res.error.code}`;
      setStatus(els.keyStatus, msg, 'error');
      return;
    }
    available = res.bibles || [];
    setStatus(els.keyStatus, `Key works — ${displayList().length} version(s) you added.`, 'ok');
    renderTranslations();
  }

  async function save() {
    const enabled = checkedTranslations();
    let defaultId = els.defaultTranslation.value;
    if (!enabled.some((t) => t.id === defaultId)) defaultId = enabled.length ? enabled[0].id : '';

    // The module normalizes every field, so the form can hand over raw values.
    // patch, not replace: the form covers only these settings — the panel's own
    // state (panelMode, panelCollapsed) must survive a Save untouched.
    settings = await SETTINGS.patch({
      apiKey: els.apiKey.value,
      provider: C.PROVIDER_APIBIBLE,
      enabledTranslations: enabled,
      defaultTranslationId: defaultId,
      actOnNonEngOnly: els.actOnNonEngOnly.checked,
      scrollToSnippet: els.scrollToSnippet.checked,
      citationView: els.citationView.value,
      showCitationToggle: els.showCitationToggle.checked,
      sidebarWidth: els.sidebarWidth.value,
    });
    setStatus(els.saveStatus, 'Saved.', 'ok');
    setTimeout(() => setStatus(els.saveStatus, '', ''), 2000);
  }

  async function init() {
    settings = await SETTINGS.get();

    els.apiKey.value = settings.apiKey;
    els.actOnNonEngOnly.checked = settings.actOnNonEngOnly;
    els.scrollToSnippet.checked = settings.scrollToSnippet;
    els.citationView.value = settings.citationView;
    els.showCitationToggle.checked = settings.showCitationToggle;

    // Slider range comes from the settings module, so the three places that
    // used to hardcode 280/900 can't drift apart.
    els.sidebarWidth.min = String(SETTINGS.SIDEBAR_WIDTH_MIN);
    els.sidebarWidth.max = String(SETTINGS.SIDEBAR_WIDTH_MAX);
    const w = settings.sidebarWidth;
    els.sidebarWidth.value = String(w);
    els.sidebarWidthOut.textContent = w + 'px';
    els.sidebarWidth.addEventListener('input', () => {
      els.sidebarWidthOut.textContent = els.sidebarWidth.value + 'px';
    });

    els.toggleKey.addEventListener('click', () => {
      const showing = els.apiKey.type === 'text';
      els.apiKey.type = showing ? 'password' : 'text';
      els.toggleKey.textContent = showing ? 'Show' : 'Hide';
    });
    els.testKey.addEventListener('click', testKey);
    els.save.addEventListener('click', save);

    // Auto-test if a key is already stored, to populate the list.
    if (settings.apiKey) testKey();
  }

  init();
})();
