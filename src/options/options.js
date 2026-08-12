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

  // The single-value settings this form edits, each paired with the control
  // that shows it. One table, so Save and the live refresh below can't
  // disagree about which control holds which setting. The translation list is
  // not here — it is built from the key test, not from one control.
  const FIELDS = [
    { key: 'apiKey', node: els.apiKey, read: () => els.apiKey.value, write: (v) => { els.apiKey.value = v; } },
    { key: 'actOnNonEngOnly', node: els.actOnNonEngOnly, read: () => els.actOnNonEngOnly.checked, write: (v) => { els.actOnNonEngOnly.checked = v; } },
    { key: 'scrollToSnippet', node: els.scrollToSnippet, read: () => els.scrollToSnippet.checked, write: (v) => { els.scrollToSnippet.checked = v; } },
    { key: 'citationView', node: els.citationView, read: () => els.citationView.value, write: (v) => { els.citationView.value = v; } },
    { key: 'showCitationToggle', node: els.showCitationToggle, read: () => els.showCitationToggle.checked, write: (v) => { els.showCitationToggle.checked = v; } },
    {
      key: 'sidebarWidth',
      node: els.sidebarWidth,
      read: () => els.sidebarWidth.value,
      write: (v) => { els.sidebarWidth.value = String(v); els.sidebarWidthOut.textContent = v + 'px'; },
    },
  ];

  // Fields the user has edited since the last Save. An unsaved edit outranks a
  // change arriving from elsewhere, so those controls are left alone.
  const dirty = new Set();

  async function save() {
    const enabled = checkedTranslations();
    let defaultId = els.defaultTranslation.value;
    if (!enabled.some((t) => t.id === defaultId)) defaultId = enabled.length ? enabled[0].id : '';

    // The module normalizes every field, so the form can hand over raw values.
    // patch, not replace: the form covers only these settings — the panel's own
    // state (panelMode, panelCollapsed) must survive a Save untouched.
    const partial = {
      provider: C.PROVIDER_APIBIBLE,
      enabledTranslations: enabled,
      defaultTranslationId: defaultId,
    };
    for (const f of FIELDS) partial[f.key] = f.read();

    settings = await SETTINGS.patch(partial);
    dirty.clear();
    setStatus(els.saveStatus, 'Saved.', 'ok');
    setTimeout(() => setStatus(els.saveStatus, '', ''), 2000);
  }

  // Paint the stored settings onto the form. `keys` limits it to the settings
  // that actually moved (a live change from another context); omit it for the
  // whole form. The form is an editor of the stored settings, not a second
  // copy of them: what the panel changes while this page is open lands here
  // too, so a later Save can't write a stale value back over it.
  function fillForm(keys) {
    for (const f of FIELDS) {
      if (keys && (!keys.includes(f.key) || dirty.has(f.key))) continue;
      f.write(settings[f.key]);
    }
  }

  async function init() {
    settings = await SETTINGS.get();

    // Slider range comes from the settings module, so the three places that
    // used to hardcode 280/900 can't drift apart.
    els.sidebarWidth.min = String(SETTINGS.SIDEBAR_WIDTH_MIN);
    els.sidebarWidth.max = String(SETTINGS.SIDEBAR_WIDTH_MAX);
    fillForm();

    for (const f of FIELDS) {
      const mark = () => dirty.add(f.key);
      f.node.addEventListener('input', mark);
      f.node.addEventListener('change', mark);
    }

    // Another context (the in-panel sub-toggle, a drag-resize, another synced
    // machine) changed a setting -> adopt it into the form. `own` writes are
    // this page's own Save, already on screen.
    SETTINGS.subscribe(({ next, changed, own }) => {
      if (own) return;
      settings = next;
      fillForm(changed);
    });

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
