#!/usr/bin/env node
/*
 * No-build sanity checks for the options form's pure core. Run:
 *   node tools/validate-options-form.js
 *
 * src/options/options.js exports the decisions the form makes that are not
 * about the DOM (the shell is skipped when `document` is undefined): which
 * versions start checked, which default id wins, what a Save may write for the
 * translation list, and which controls a change arriving from another context
 * is allowed to repaint. Those are the rules the stale-list bugs lived in.
 *
 * Exits non-zero on any failure so it can gate a commit.
 */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'src/options/options.js'));

let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); failures++; }
}
function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { console.error(`  ✗ ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failures++; }
}

const NIV = { id: 'niv', name: 'New International Version', abbr: 'NIV' };
const NKJV = { id: 'nkjv', name: 'New King James Version', abbr: 'NKJV' };
const ESV = { id: 'esv', name: 'English Standard Version', abbr: 'ESV' };

// ---- initialChecks: which versions start checked ----
console.log('initialChecks:');
eq(F.initialChecks([NIV, NKJV], [{ id: 'nkjv' }]), ['nkjv'],
  'a stored selection decides what is checked');
eq(F.initialChecks([NIV, NKJV], []), ['niv', 'nkjv'],
  'no stored selection -> every version on the key is checked');
eq(F.initialChecks([NIV, NKJV], undefined), ['niv', 'nkjv'],
  'a missing stored list is treated as no selection');
eq(F.initialChecks([NIV, NKJV], [{ id: 'esv' }]), [],
  'a stored selection naming nothing on the key checks nothing');
eq(F.initialChecks([], [{ id: 'niv' }]), [], 'no versions -> nothing checked');

// ---- pickDefaultId: which default survives ----
console.log('pickDefaultId:');
eq(F.pickDefaultId([NIV, NKJV], 'nkjv'), 'nkjv', 'a wanted id that is enabled wins');
eq(F.pickDefaultId([NIV, NKJV], 'esv'), 'niv', 'a wanted id that is not enabled falls back to the first');
eq(F.pickDefaultId([NIV, NKJV], ''), 'niv', 'no wanted id falls back to the first');
eq(F.pickDefaultId([], 'niv'), '', 'nothing enabled -> no default');
eq(F.pickDefaultId([NIV], undefined), 'niv', 'an undefined wanted id is not a crash');

// ---- translationPatch: what a Save may write for the list ----
console.log('translationPatch:');
eq(F.translationPatch({ versionsLoaded: false, enabled: [], defaultId: '' }), {},
  'an untested key writes nothing (the stored list is not wiped)');
eq(F.translationPatch({ versionsLoaded: false, enabled: [NIV], defaultId: 'niv' }), {},
  'even with checkboxes on screen, an unloaded list writes nothing');
eq(F.translationPatch({ versionsLoaded: true, enabled: [NIV, NKJV], defaultId: 'nkjv' }),
  { enabledTranslations: [NIV, NKJV], defaultTranslationId: 'nkjv' },
  'a loaded list writes both keys');
eq(F.translationPatch({ versionsLoaded: true, enabled: [NIV], defaultId: 'esv' }),
  { enabledTranslations: [NIV], defaultTranslationId: 'niv' },
  'a default that is no longer enabled is repaired, not saved');
eq(F.translationPatch({ versionsLoaded: true, enabled: [], defaultId: 'niv' }),
  { enabledTranslations: [], defaultTranslationId: '' },
  'a key that really has no versions may save an empty list');

// ---- fillPlan: what an incoming change is allowed to repaint ----
console.log('fillPlan:');
const FIELD_KEYS = ['apiKey', 'citationView', 'sidebarWidth'];
const plan = (changed, dirty) => F.fillPlan({ fieldKeys: FIELD_KEYS, changed, dirty });

eq(plan(null, []), { fields: FIELD_KEYS, relist: true, reselect: false },
  'the initial fill (no `changed`) paints every field and the list');
eq(plan(['citationView'], []), { fields: ['citationView'], relist: false, reselect: false },
  'a single-value change repaints only that control');
eq(plan(['enabledTranslations'], []), { fields: [], relist: true, reselect: false },
  'an external list change repaints the list');
eq(plan(['defaultTranslationId'], []), { fields: [], relist: false, reselect: true },
  'an external default change repaints just the select');
eq(plan(['enabledTranslations', 'defaultTranslationId'], []),
  { fields: [], relist: true, reselect: false },
  'a relist rebuilds the select too, so reselect is not asked for as well');
eq(plan(['panelMode', 'panelCollapsed'], []), { fields: [], relist: false, reselect: false },
  'settings this form does not edit repaint nothing');

// Unsaved edits outrank a change arriving from elsewhere.
eq(plan(['citationView'], ['citationView']), { fields: [], relist: false, reselect: false },
  'a field the user has edited is left alone');
eq(plan(['enabledTranslations'], ['enabledTranslations']), { fields: [], relist: false, reselect: false },
  'checkboxes the user has edited are left alone');
eq(plan(['defaultTranslationId'], ['defaultTranslationId']), { fields: [], relist: false, reselect: false },
  'a default the user has edited is left alone');
eq(plan(['enabledTranslations'], ['defaultTranslationId']), { fields: [], relist: false, reselect: false },
  'a relist would rebuild the edited select, so it waits too');
eq(plan(null, ['citationView', 'enabledTranslations']),
  { fields: FIELD_KEYS, relist: true, reselect: false },
  'the initial fill predates any edit, so dirt does not hold it back');

// ---- the DOM shell stays out of Node ----
console.log('Shell:');
check(typeof F.init === 'undefined', 'requiring the page in Node exposes only the pure core');

// ---- the shell actually uses the core ----
console.log('Wiring:');
const fs = require('fs');
const src = fs.readFileSync(path.join(ROOT, 'src/options/options.js'), 'utf8');
check(/translationPatch\(/.test(src) && /Object\.assign\(partial, translationPatch/.test(src),
  'Save routes the translation list through translationPatch');
check(!/prev = els\.defaultTranslation\.value/.test(src),
  'refreshDefaultOptions no longer prefers the control it is about to rebuild');
check(/function refreshDefaultOptions\(wanted\)/.test(src),
  'refreshDefaultOptions takes the id to preselect as an argument');
check(/fillPlan\(/.test(src), 'the live refresh asks fillPlan what to repaint');

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
