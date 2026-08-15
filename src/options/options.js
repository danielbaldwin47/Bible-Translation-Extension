/*
 * Options page logic. Reads/writes settings through __BTX.settings (which owns
 * the schema, defaults and normalization — this page never coerces a stored
 * value itself), tests the api.bible key (via the worker), and lets the user
 * pick which translations to enable + the default.
 *
 * Only api.bible is supported, and the list is filtered to the copyrighted
 * versions the user added (free public-domain/CC versions are hidden).
 *
 * The form is an editor of the stored settings, not a second copy of them:
 * every control is filled from storage and refilled when a change arrives from
 * another context, and a Save never writes a value the form does not know.
 * The decisions behind that (below) are pure and exported for Node
 * (tools/validate-options-form.js); the DOM shell is skipped there.
 */
(function (root) {
  'use strict';

  // ---- Pure form core (Node-testable) ------------------------------------

  // Which versions start checked. A stored selection decides; with none (a key
  // tested for the first time) every version on the key is checked, since
  // those are the versions the user chose to add over at api.bible.
  function initialChecks(list, stored) {
    const ids = (list || []).map((t) => t.id);
    const enabled = (stored || []).map((t) => t && t.id);
    if (!enabled.length) return ids;
    return ids.filter((id) => enabled.indexOf(id) >= 0);
  }

  // The default version has to be one of the enabled ones; falling back to the
  // first is what the <select> would show anyway.
  function pickDefaultId(enabled, wanted) {
    const list = enabled || [];
    if (list.some((t) => t.id === wanted)) return wanted;
    return list.length ? list[0].id : '';
  }

  // What a Save may write for the translation list. Until the key test has
  // returned, the form has no idea which versions exist, so the checkboxes on
  // screen say nothing about the stored list — writing them would wipe it.
  function translationPatch({ versionsLoaded, enabled, defaultId }) {
    if (!versionsLoaded) return {};
    return {
      enabledTranslations: enabled,
      defaultTranslationId: pickDefaultId(enabled, defaultId),
    };
  }

  // What an incoming settings change is allowed to repaint. `changed` is the
  // list of keys that actually moved (omit it for the initial fill, which
  // predates any edit); `dirty` is the Set of keys the user has edited since
  // the last Save. A field the user has edited outranks the change: their
  // unsaved work is not overwritten. Rebuilding the checkbox list rebuilds the
  // default <select> with it, so a relist waits on an edited default too, and
  // never asks for a separate reselect.
  function fillPlan({ fieldKeys, changed, dirty }) {
    const initial = !changed;
    const dirtyKey = (k) => !initial && !!dirty && dirty.has(k);
    const inScope = (k) => initial || changed.indexOf(k) >= 0;
    const wants = (k) => inScope(k) && !dirtyKey(k);

    const relist = wants('enabledTranslations') && !dirtyKey('defaultTranslationId');
    return {
      fields: (fieldKeys || []).filter(wants),
      relist,
      reselect: !relist && wants('defaultTranslationId'),
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initialChecks, pickDefaultId, translationPatch, fillPlan };
  }
  if (typeof document === 'undefined') return; // Node: the pure core only.

  // ---- DOM shell ---------------------------------------------------------

  const C = root.__BTX.const;
  const SETTINGS = root.__BTX.settings;

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
    citationSourceMark: $('citationSourceMark'),
    showCitationToggle: $('showCitationToggle'),
    scrollSync: $('scrollSync'),
    sidebarWidth: $('sidebarWidth'),
    sidebarWidthOut: $('sidebarWidthOut'),
    fontScale: $('fontScale'),
    fontScaleOut: $('fontScaleOut'),
    save: $('save'),
    saveStatus: $('saveStatus'),
  };

  let available = []; // all versions the key returns: [{id, name, abbr, copyright, provider}]
  let versionsLoaded = false; // has a key test ever returned a version list?
  let settings = SETTINGS.defaults();

  // Fields the user has edited since the last Save. An unsaved edit outranks a
  // change arriving from elsewhere, so those controls are left alone.
  const dirty = new Set();

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

  // The default to preselect when the list is (re)built: the user's unsaved
  // pick if they have one, otherwise the stored setting.
  function preferredDefaultId() {
    return dirty.has('defaultTranslationId') ? els.defaultTranslation.value : settings.defaultTranslationId;
  }

  function renderTranslations(wanted) {
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

    const checkedIds = new Set(initialChecks(list, settings.enabledTranslations));

    for (const t of list) {
      const label = document.createElement('label');
      label.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = t.id;
      cb.checked = checkedIds.has(t.id);
      cb.addEventListener('change', () => {
        dirty.add('enabledTranslations');
        // The user's on-screen pick survives a checkbox toggle.
        refreshDefaultOptions(els.defaultTranslation.value);
      });
      const span = document.createElement('span');
      span.textContent = t.abbr ? `${t.abbr} — ${t.name}` : t.name;
      label.appendChild(cb);
      label.appendChild(span);
      els.translationsList.appendChild(label);
    }
    refreshDefaultOptions(wanted);
  }

  function checkedTranslations() {
    const ids = new Set(
      Array.from(els.translationsList.querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value)
    );
    return available.filter((t) => ids.has(t.id));
  }

  // `wanted` is the id to preselect — passed in, never read back off the
  // control this rebuilds (a populated <select> always has a value, which
  // would otherwise beat the stored setting every time).
  function refreshDefaultOptions(wanted) {
    const checked = checkedTranslations();
    els.defaultTranslation.textContent = '';
    for (const t of checked) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.abbr ? `${t.abbr} — ${t.name}` : t.name;
      els.defaultTranslation.appendChild(opt);
    }
    els.defaultTranslation.value = pickDefaultId(checked, wanted);
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
    versionsLoaded = true;
    setStatus(els.keyStatus, `Key works — ${displayList().length} version(s) you added.`, 'ok');
    renderTranslations(preferredDefaultId());
  }

  const pct = (v) => Math.round(Number(v) * 100) + '%';

  // The single-value settings this form edits, each paired with the control
  // that shows it. One table, so Save and the live refresh below can't
  // disagree about which control holds which setting. The translation list is
  // not here — it is built from the key test, not from one control — but it
  // goes through the same dirty flag and the same fill plan.
  const FIELDS = [
    { key: 'apiKey', node: els.apiKey, read: () => els.apiKey.value, write: (v) => { els.apiKey.value = v; } },
    { key: 'actOnNonEngOnly', node: els.actOnNonEngOnly, read: () => els.actOnNonEngOnly.checked, write: (v) => { els.actOnNonEngOnly.checked = v; } },
    { key: 'scrollToSnippet', node: els.scrollToSnippet, read: () => els.scrollToSnippet.checked, write: (v) => { els.scrollToSnippet.checked = v; } },
    { key: 'citationView', node: els.citationView, read: () => els.citationView.value, write: (v) => { els.citationView.value = v; } },
    { key: 'citationSourceMark', node: els.citationSourceMark, read: () => els.citationSourceMark.value, write: (v) => { els.citationSourceMark.value = v; } },
    { key: 'showCitationToggle', node: els.showCitationToggle, read: () => els.showCitationToggle.checked, write: (v) => { els.showCitationToggle.checked = v; } },
    { key: 'scrollSync', node: els.scrollSync, read: () => els.scrollSync.checked, write: (v) => { els.scrollSync.checked = v; } },
    {
      key: 'sidebarWidth',
      node: els.sidebarWidth,
      read: () => els.sidebarWidth.value,
      write: (v) => { els.sidebarWidth.value = String(v); els.sidebarWidthOut.textContent = v + 'px'; },
    },
    {
      key: 'fontScale',
      node: els.fontScale,
      // Stored as a multiplier, shown as a percentage — the slider walks the
      // multiplier so the module's clamp/step is the only rule about it.
      read: () => els.fontScale.value,
      write: (v) => { els.fontScale.value = String(v); els.fontScaleOut.textContent = pct(v); },
    },
  ];
  const FIELD_KEYS = FIELDS.map((f) => f.key);

  async function save() {
    // The module normalizes every field, so the form can hand over raw values.
    // patch, not replace: the form covers only these settings — the panel's own
    // state (panelMode, panelCollapsed) must survive a Save untouched, and so
    // must the translation list when this page never loaded it.
    const partial = { provider: C.PROVIDER_APIBIBLE };
    for (const f of FIELDS) partial[f.key] = f.read();
    Object.assign(partial, translationPatch({
      versionsLoaded,
      enabled: checkedTranslations(),
      defaultId: els.defaultTranslation.value,
    }));

    settings = await SETTINGS.patch(partial);
    dirty.clear();
    setStatus(els.saveStatus, 'Saved.', 'ok');
    setTimeout(() => setStatus(els.saveStatus, '', ''), 2000);
  }

  // Paint the stored settings onto the form. `changed` limits it to the
  // settings that actually moved (a live change from another context); omit it
  // for the whole form. What the panel — or another synced machine — changes
  // while this page is open lands here too, so a later Save can't write a
  // stale value back over it.
  function fillForm(changed) {
    const plan = fillPlan({ fieldKeys: FIELD_KEYS, changed, dirty });
    for (const f of FIELDS) {
      if (plan.fields.indexOf(f.key) >= 0) f.write(settings[f.key]);
    }
    if (plan.relist) renderTranslations(preferredDefaultId());
    else if (plan.reselect) refreshDefaultOptions(preferredDefaultId());
  }

  async function init() {
    settings = await SETTINGS.get();

    // Slider range comes from the settings module, so the three places that
    // used to hardcode 280/900 can't drift apart.
    els.sidebarWidth.min = String(SETTINGS.SIDEBAR_WIDTH_MIN);
    els.sidebarWidth.max = String(SETTINGS.SIDEBAR_WIDTH_MAX);
    els.fontScale.min = String(SETTINGS.FONT_SCALE_MIN);
    els.fontScale.max = String(SETTINGS.FONT_SCALE_MAX);
    els.fontScale.step = String(SETTINGS.FONT_SCALE_STEP);
    fillForm();

    for (const f of FIELDS) {
      const mark = () => dirty.add(f.key);
      f.node.addEventListener('input', mark);
      f.node.addEventListener('change', mark);
    }
    els.defaultTranslation.addEventListener('change', () => dirty.add('defaultTranslationId'));

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
    els.fontScale.addEventListener('input', () => {
      els.fontScaleOut.textContent = pct(els.fontScale.value);
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
})(typeof globalThis !== 'undefined' ? globalThis : this);
