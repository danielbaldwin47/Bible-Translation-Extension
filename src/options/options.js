/*
 * Options page logic. Loads/saves settings to chrome.storage.sync, tests the
 * api.bible key (via the worker), and lets the user pick which translations to
 * enable + the default. Shared constants are available on window.__BTX.
 */
(function () {
  'use strict';

  const C = window.__BTX.const;

  const $ = (id) => document.getElementById(id);
  const els = {
    providerRadios: () => document.querySelectorAll('input[name="provider"]'),
    apiKey: $('apiKey'),
    toggleKey: $('toggleKey'),
    testKey: $('testKey'),
    keyStatus: $('keyStatus'),
    keyCard: $('keyCard'),
    translationsHint: $('translationsHint'),
    translationsList: $('translationsList'),
    defaultTranslation: $('defaultTranslation'),
    actOnNonEngOnly: $('actOnNonEngOnly'),
    save: $('save'),
    saveStatus: $('saveStatus'),
  };

  let available = []; // [{id, name, abbr, copyright, provider}]
  let settings = C.defaultSettings();

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) resolve({ error: { code: 'NETWORK', message: chrome.runtime.lastError.message } });
        else resolve(res);
      });
    });
  }

  function selectedProvider() {
    const checked = document.querySelector('input[name="provider"]:checked');
    return checked ? checked.value : C.PROVIDER_APIBIBLE;
  }

  function isDefaultAbbr(abbr) {
    const up = (abbr || '').toUpperCase();
    return C.DEFAULT_ABBRS.some((d) => up === d || up.startsWith(d));
  }

  function setStatus(elm, msg, kind) {
    elm.textContent = msg;
    elm.className = 'status' + (kind ? ' ' + kind : '');
  }

  function renderTranslations() {
    els.translationsList.textContent = '';
    if (!available.length) {
      els.translationsHint.textContent = selectedProvider() === C.PROVIDER_APIBIBLE
        ? 'Test your key to load the versions it can access.'
        : 'Public-domain versions are listed below.';
      els.defaultTranslation.textContent = '';
      return;
    }
    els.translationsHint.textContent = 'Check the versions you want available in the dropdown.';

    const enabledIds = new Set((settings.enabledTranslations || []).map((t) => t.id));
    const hasPriorSelection = enabledIds.size > 0;

    for (const t of available) {
      const checked = hasPriorSelection ? enabledIds.has(t.id) : isDefaultAbbr(t.abbr);
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
    setStatus(els.keyStatus, `Key works — ${available.length} English versions available.`, 'ok');
    renderTranslations();
  }

  function loadProviderTranslations() {
    if (selectedProvider() === C.PROVIDER_BIBLEAPI) {
      els.keyCard.style.opacity = '0.5';
      available = C.BIBLE_API_TRANSLATIONS.map((t) => Object.assign({ provider: C.PROVIDER_BIBLEAPI, copyright: 'Public domain' }, t));
      renderTranslations();
    } else {
      els.keyCard.style.opacity = '1';
      // api.bible: populate only after a successful test (or auto-test if a key exists).
      available = [];
      renderTranslations();
      if (els.apiKey.value.trim()) testKey();
    }
  }

  async function save() {
    const provider = selectedProvider();
    const enabled = checkedTranslations();
    let defaultId = els.defaultTranslation.value;
    if (!enabled.some((t) => t.id === defaultId)) defaultId = enabled.length ? enabled[0].id : '';

    const next = {
      apiKey: els.apiKey.value.trim(),
      provider,
      enabledTranslations: enabled,
      defaultTranslationId: defaultId,
      actOnNonEngOnly: els.actOnNonEngOnly.checked,
    };
    await chrome.storage.sync.set({ [C.SETTINGS_KEY]: next });
    settings = next;
    setStatus(els.saveStatus, 'Saved.', 'ok');
    setTimeout(() => setStatus(els.saveStatus, '', ''), 2000);
  }

  async function init() {
    const data = await chrome.storage.sync.get(C.SETTINGS_KEY);
    settings = Object.assign(C.defaultSettings(), data[C.SETTINGS_KEY] || {});

    // Hydrate form.
    els.providerRadios().forEach((r) => { r.checked = r.value === settings.provider; });
    els.apiKey.value = settings.apiKey || '';
    els.actOnNonEngOnly.checked = settings.actOnNonEngOnly !== false;

    els.providerRadios().forEach((r) => r.addEventListener('change', loadProviderTranslations));
    els.toggleKey.addEventListener('click', () => {
      const showing = els.apiKey.type === 'text';
      els.apiKey.type = showing ? 'password' : 'text';
      els.toggleKey.textContent = showing ? 'Show' : 'Hide';
    });
    els.testKey.addEventListener('click', testKey);
    els.save.addEventListener('click', save);

    loadProviderTranslations();
  }

  init();
})();
