#!/usr/bin/env node
/*
 * No-build sanity checks for the settings module. Run:
 *   node tools/validate-settings.js
 *
 * Covers the pure parts of `__BTX.settings` — the schema, the per-field
 * normalizers, and `diff` — the parts every context (content script, options
 * page, service worker) shares. The chrome.storage side is not exercised here.
 *
 * Exits non-zero on any failure so it can gate a commit.
 */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'src/shared/constants.js'));
const S = require(path.join(ROOT, 'src/shared/settings.js'));

let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); failures++; }
}
function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { console.error(`  ✗ ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failures++; }
}

// ---- Schema ----
console.log('Schema:');
const KEYS = [
  'apiKey', 'provider', 'enabledTranslations', 'defaultTranslationId',
  'actOnNonEngOnly', 'sidebarWidth', 'scrollToSnippet', 'citationView',
  'showCitationToggle', 'panelMode', 'panelCollapsed', 'scrollSync',
];
check(Array.isArray(S.KEYS), 'exports KEYS');
eq(S.KEYS.slice().sort(), KEYS.slice().sort(), 'KEYS covers exactly the known settings');

const d = S.defaults();
eq(Object.keys(d).sort(), KEYS.slice().sort(), 'defaults() has exactly the schema keys');
check(S.defaults() !== S.defaults(), 'defaults() returns a fresh object each call');
d.citationView = 'verse';
eq(S.defaults().citationView, 'source', 'mutating a defaults() result does not leak');

check(!('defaultSettings' in C), 'constants no longer owns defaultSettings (settings module does)');

// ---- normalize: fills defaults ----
console.log('normalize (defaults):');
eq(S.normalize(undefined), S.defaults(), 'normalize(undefined) === defaults');
eq(S.normalize(null), S.defaults(), 'normalize(null) === defaults');
eq(S.normalize('nonsense'), S.defaults(), 'normalize(non-object) === defaults');
eq(S.normalize({}), S.defaults(), 'normalize({}) === defaults');
eq(Object.keys(S.normalize({ bogusKey: 1 })).sort(), KEYS.slice().sort(), 'unknown keys are dropped');
eq(S.normalize(S.defaults()), S.defaults(), 'normalize is idempotent on defaults');

// ---- normalize: citationView (the previously-inverted one) ----
console.log('normalize (citationView):');
eq(S.defaults().citationView, 'source', 'documented citationView default is "source"');
eq(S.normalize({ citationView: 'verse' }).citationView, 'verse', 'citationView "verse" survives');
eq(S.normalize({ citationView: 'source' }).citationView, 'source', 'citationView "source" survives');
for (const bad of ['VERSE', 'by-verse', '', 0, null, {}, undefined]) {
  eq(S.normalize({ citationView: bad }).citationView, 'source',
    `citationView ${JSON.stringify(bad)} falls back to "source"`);
}

// ---- normalize: panelMode (the panel's persisted mode preference) ----
console.log('normalize (panelMode):');
eq(S.defaults().panelMode, 'translation', 'panelMode defaults to "translation"');
eq(S.normalize({ panelMode: 'citations' }).panelMode, 'citations', 'panelMode "citations" survives');
eq(S.normalize({ panelMode: 'translation' }).panelMode, 'translation', 'panelMode "translation" survives');
for (const bad of ['CITATIONS', 'both', '', 0, null, {}, undefined]) {
  eq(S.normalize({ panelMode: bad }).panelMode, 'translation',
    `panelMode ${JSON.stringify(bad)} falls back to "translation"`);
}

// ---- normalize: panelCollapsed (default-false boolean) ----
console.log('normalize (panelCollapsed):');
eq(S.defaults().panelCollapsed, false, 'panelCollapsed defaults to false');
eq(S.normalize({ panelCollapsed: true }).panelCollapsed, true, 'panelCollapsed true survives');
eq(S.normalize({ panelCollapsed: false }).panelCollapsed, false, 'panelCollapsed false survives');
for (const bad of ['true', 1, null, undefined, {}]) {
  eq(S.normalize({ panelCollapsed: bad }).panelCollapsed, false,
    `panelCollapsed ${JSON.stringify(bad)} falls back to false`);
}

// ---- normalize: booleans ----
console.log('normalize (booleans):');
for (const key of ['actOnNonEngOnly', 'scrollToSnippet', 'showCitationToggle', 'scrollSync']) {
  eq(S.defaults()[key], true, `${key} defaults to true`);
  eq(S.normalize({ [key]: false })[key], false, `${key} false survives`);
  eq(S.normalize({ [key]: true })[key], true, `${key} true survives`);
  // Legacy `x !== false` semantics: anything not exactly false reads as true.
  for (const bad of ['false', 0, null, undefined, 1]) {
    eq(S.normalize({ [key]: bad })[key], true, `${key} ${JSON.stringify(bad)} falls back to true`);
  }
}

// ---- normalize: sidebarWidth ----
console.log('normalize (sidebarWidth):');
eq(S.defaults().sidebarWidth, 380, 'sidebarWidth defaults to 380');
eq(S.normalize({ sidebarWidth: 500 }).sidebarWidth, 500, 'in-range width survives');
eq(S.normalize({ sidebarWidth: '500' }).sidebarWidth, 500, 'numeric string width is coerced');
eq(S.normalize({ sidebarWidth: 500.4 }).sidebarWidth, 500, 'width is rounded');
eq(S.normalize({ sidebarWidth: 10 }).sidebarWidth, S.SIDEBAR_WIDTH_MIN, 'width clamps up to the min');
eq(S.normalize({ sidebarWidth: 99999 }).sidebarWidth, S.SIDEBAR_WIDTH_MAX, 'width clamps down to the max');
for (const bad of ['wide', NaN, Infinity, null, {}]) {
  eq(S.normalize({ sidebarWidth: bad }).sidebarWidth, 380, `width ${String(bad)} falls back to 380`);
}
check(S.SIDEBAR_WIDTH_MIN === 280 && S.SIDEBAR_WIDTH_MAX === 900,
  'width bounds match the panel clamp + options slider (280–900)');

// ---- normalize: strings / provider / translations ----
console.log('normalize (strings, provider, translations):');
eq(S.normalize({ apiKey: '  abc  ' }).apiKey, 'abc', 'apiKey is trimmed');
eq(S.normalize({ apiKey: 42 }).apiKey, '', 'non-string apiKey falls back to ""');
eq(S.normalize({ defaultTranslationId: ' xyz ' }).defaultTranslationId, 'xyz', 'defaultTranslationId is trimmed');
eq(S.normalize({ provider: C.PROVIDER_BIBLEAPI }).provider, C.PROVIDER_BIBLEAPI, 'known provider survives');
eq(S.normalize({ provider: 'made-up' }).provider, C.PROVIDER_APIBIBLE, 'unknown provider falls back to api.bible');
eq(S.defaults().provider, C.PROVIDER_APIBIBLE, 'provider defaults to api.bible');

const trs = [{ id: 'a', name: 'A' }, { id: '', name: 'empty' }, null, 'nope', { name: 'no id' }];
eq(S.normalize({ enabledTranslations: trs }).enabledTranslations, [{ id: 'a', name: 'A' }],
  'enabledTranslations keeps only entries with a non-empty id');
eq(S.normalize({ enabledTranslations: 'nope' }).enabledTranslations, [], 'non-array enabledTranslations -> []');

// ---- diff ----
console.log('diff:');
eq(S.diff(S.defaults(), S.defaults()), [], 'identical settings diff to []');
eq(S.diff(undefined, undefined), [], 'diff(undefined, undefined) === []');
eq(S.diff(S.defaults(), { sidebarWidth: 500 }), ['sidebarWidth'], 'width-only change reports just sidebarWidth');
eq(S.diff({ sidebarWidth: 500 }, S.defaults()), ['sidebarWidth'], 'diff is symmetric');
eq(S.diff(S.defaults(), { citationView: 'verse', sidebarWidth: 500 }).sort(),
  ['citationView', 'sidebarWidth'], 'multi-field change reports every changed key');
eq(S.diff({ citationView: 'source' }, { citationView: 'nonsense' }), [],
  'diff normalizes first, so two values that mean the same do not differ');
eq(S.diff(S.defaults(), { bogusKey: 1 }), [], 'unknown keys never show up in a diff');
eq(S.diff({ enabledTranslations: [{ id: 'a' }] }, { enabledTranslations: [{ id: 'b' }] }),
  ['enabledTranslations'], 'deep (array) changes are detected');
eq(S.diff({ enabledTranslations: [{ id: 'a' }] }, { enabledTranslations: [{ id: 'a' }] }),
  [], 'deep-equal arrays do not diff');

// diff is what replaces the old `sameExceptWidth` hack.
const widthOnly = S.diff(S.defaults(), { sidebarWidth: 500 });
check(widthOnly.length === 1 && widthOnly[0] === 'sidebarWidth',
  'a width-only change is distinguishable from a render-affecting one');

// ---- Storage layer, against a fake chrome.storage.sync ----
// Not "pure", but the own-write filter is what replaced `suppressNextViewRender`
// and it is worth pinning down.
async function storageChecks() {
  console.log('Storage (get/patch/replace/subscribe):');

  let store = {};
  let failWrites = false;
  const changeListeners = [];
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      sync: {
        get(key, cb) { cb({ [key]: store[key] }); },
        set(obj, cb) {
          if (failWrites) { // e.g. sync quota exceeded
            chrome.runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
            if (cb) cb();
            chrome.runtime.lastError = null;
            return;
          }
          const key = Object.keys(obj)[0];
          const oldValue = store[key];
          store[key] = obj[key];
          if (cb) cb();
          for (const fn of changeListeners) fn({ [key]: { newValue: obj[key], oldValue } }, 'sync');
        },
      },
      onChanged: { addListener(fn) { changeListeners.push(fn); } },
    },
  };
  const lastEvent = () => events[events.length - 1];

  const events = [];
  S.subscribe((e) => events.push(e));

  eq(await S.get(), S.defaults(), 'get() on empty storage returns defaults');

  // Our own write: applied to storage, echoed back flagged as own.
  await S.patch({ citationView: 'verse' });
  eq(store.btxSettings.citationView, 'verse', 'patch writes through to storage');
  check(events.length === 1, `own write notifies once (got ${events.length})`);
  eq(events[0].changed, ['citationView'], 'own write reports the changed key');
  check(events[0].own === true, 'own write is flagged own:true');
  eq(events[0].prev.citationView, 'source', 'event carries the previous value');
  eq((await S.get()).citationView, 'verse', 'get() reflects the write');
  eq((await S.get()).sidebarWidth, 380, 'patch leaves other settings alone');

  // Someone else's write (the options page saving) is not flagged own.
  const external = Object.assign(S.defaults(), { citationView: 'verse', sidebarWidth: 500 });
  chrome.storage.sync.set({ btxSettings: external });
  check(events.length === 2, `external write notifies (got ${events.length})`);
  eq(events[1].changed, ['sidebarWidth'], 'external write reports only what changed');
  check(events[1].own === false, 'external write is flagged own:false');

  // A re-save of identical values is not a change at all.
  chrome.storage.sync.set({ btxSettings: external });
  check(events.length === 2, 'a no-op re-save does not notify');

  // replace() fills defaults for anything the caller omitted.
  const after = await S.replace({ citationView: 'verse' });
  eq(after.sidebarWidth, 380, 'replace() resets omitted fields to their defaults');
  check(events[events.length - 1].own === true, 'replace() is flagged own:true');

  // Two own writes in flight are matched independently.
  const before = events.length;
  await S.patch({ sidebarWidth: 420 });
  await S.patch({ sidebarWidth: 460 });
  check(events.length === before + 2, 'each own write notifies once');
  check(events.slice(before).every((e) => e.own === true), 'both queued own writes stay flagged own');

  // Own writes are matched on a write tag, not on the value — so another
  // context writing exactly what we would have written is still not "own".
  chrome.storage.sync.set({ btxSettings: Object.assign(S.defaults(), { sidebarWidth: 640 }) });
  check(lastEvent().own === false, 'an external write of a value we could have made is not claimed as own');

  // A key we don't know (a setting from another version of the extension on
  // another synced machine) must survive our writes, not be deleted by them.
  chrome.storage.sync.set({ btxSettings: Object.assign(S.defaults(), { futureSetting: 'keep me' }) });
  await S.patch({ sidebarWidth: 300 });
  eq(store.btxSettings.futureSetting, 'keep me', 'an unknown key survives one of our writes');
  eq((await S.get()).sidebarWidth, 300, 'our own field still went through');
  check(!('futureSetting' in (await S.get())), 'an unknown key is still not exposed as a setting');

  // A write that never lands must not leave the cache believing it did.
  const kept = (await S.get()).sidebarWidth;
  const eventsBeforeFailure = events.length;
  failWrites = true;
  await S.patch({ sidebarWidth: 700 });
  failWrites = false;
  eq((await S.get()).sidebarWidth, kept, 'a failed write does not poison the cache');
  eq(store.btxSettings.sidebarWidth, kept, 'a failed write does not reach storage');
  check(events.length === eventsBeforeFailure, 'a failed write notifies nobody');
  // ...and its echo record must not be claimable by a later, unrelated write.
  chrome.storage.sync.set({ btxSettings: Object.assign(S.defaults(), { sidebarWidth: 700 }) });
  check(lastEvent().own === false, 'the record for a failed write cannot be claimed later');

  // The cache belongs to the module, not the caller.
  const handedOut = await S.get();
  handedOut.sidebarWidth = 12345;
  eq((await S.get()).sidebarWidth, 700, 'get() hands out a copy, not the live cache');

  delete global.chrome;
}

// ---- no raw btxSettings access outside the module ----
console.log('Ownership:');
const fs = require('fs');
const OWNERS = ['src/shared/settings.js', 'src/shared/constants.js'];
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'data') walk(p, out); }
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}
for (const file of walk(path.join(ROOT, 'src'), [])) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (OWNERS.includes(rel)) continue;
  const src = fs.readFileSync(file, 'utf8');
  check(!/storage\.sync/.test(src), `${rel} must not touch chrome.storage.sync directly`);
  check(!/SETTINGS_KEY/.test(src), `${rel} must not reference SETTINGS_KEY directly`);
  check(!/suppressNextViewRender|sameExceptWidth/.test(src), `${rel} still has an own-write/diff workaround`);
  // Panel mode/collapsed live in the settings module now; only the panel may
  // still name the legacy chrome.storage.local keys (its one-time migration).
  if (rel !== 'src/content/panel.js') {
    check(!/btxPanelMode|btxPanelCollapsed/.test(src), `${rel} references the legacy panel-state keys (panel owns them)`);
  }
}

// The width bounds live in the settings module only.
const panelSrc = fs.readFileSync(path.join(ROOT, 'src/content/panel.js'), 'utf8');
check(/SIDEBAR_WIDTH_MIN/.test(panelSrc) && /SIDEBAR_WIDTH_MAX/.test(panelSrc),
  'panel.js clampWidth reads the bounds from the settings module');
const optionsHtml = fs.readFileSync(path.join(ROOT, 'src/options/options.html'), 'utf8');
check(!/id="sidebarWidth"[^>]*\b(min|max)=/.test(optionsHtml),
  'the options slider does not hardcode its range (set from the settings module)');

// The options form edits the same settings the panel owns, so it must adopt
// external changes instead of holding a copy that goes stale behind the panel.
const optionsSrc = fs.readFileSync(path.join(ROOT, 'src/options/options.js'), 'utf8');
check(/SETTINGS\.subscribe\(/.test(optionsSrc),
  'the options page subscribes to settings changes (no stale form behind the panel)');

// Which settings the panel handles by itself is the panel's own fact: the
// orchestrator reads panel.HANDLED_KEYS rather than restating the list, so a
// change can't end up rendered twice (or not at all) through drift.
check(/HANDLED_KEYS: PANEL_HANDLED_KEYS/.test(panelSrc),
  'panel.js exposes its handled-settings list as panel.HANDLED_KEYS');
check(/PANEL_HANDLED_KEYS = \[[^\]]*'citationView'/.test(panelSrc),
  'the citation layout is a panel-handled setting');
const contentSrc = fs.readFileSync(path.join(ROOT, 'src/content/content.js'), 'utf8');
check(/PANEL_KEYS = panel\.HANDLED_KEYS/.test(contentSrc),
  'content.js takes the panel-handled key list from the panel (no second copy)');

storageChecks().then(() => {
  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
});
