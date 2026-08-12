#!/usr/bin/env node
/*
 * No-build sanity checks for the panel's pure state core. Run:
 *   node tools/validate-panel-state.js
 *
 * src/content/panel.js exports its state machine for Node (the DOM shell is
 * skipped when `document` is undefined). These checks pin down the toggle
 * semantics that used to live scattered in content.js callbacks: what a mode
 * click means, when the citation-layout toggle acts, and how a non-Bible
 * chapter forces citations.
 *
 * Exits non-zero on any failure so it can gate a commit.
 */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'src/content/panel.js'));

let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); failures++; }
}
function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { console.error(`  ✗ ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failures++; }
}

function fresh(init) {
  return P.createState(init || {});
}

// ---- createState ----
console.log('createState:');
let s = fresh();
eq(s.mode, 'translation', 'mode defaults to translation');
eq(s.citationView, 'source', 'citationView defaults to source');
eq(s.collapsed, false, 'collapsed defaults to false');
eq(s.isBible, true, 'a fresh panel assumes a Bible chapter');

s = fresh({ mode: 'citations', citationView: 'verse', collapsed: true });
eq(s.mode, 'citations', 'persisted mode is adopted');
eq(s.citationView, 'verse', 'persisted citationView is adopted');
eq(s.collapsed, true, 'persisted collapsed is adopted');

s = fresh({ mode: 'nonsense', citationView: 42, collapsed: 'yes' });
eq(s.mode, 'translation', 'garbage mode falls back to translation');
eq(s.citationView, 'source', 'garbage citationView falls back to source');
eq(s.collapsed, false, 'garbage collapsed falls back to false');

// ---- effectiveMode ----
console.log('effectiveMode:');
s = fresh({ mode: 'translation' });
eq(P.effectiveMode(s), 'translation', 'Bible + translation preference -> translation');
s.mode = 'citations';
eq(P.effectiveMode(s), 'citations', 'Bible + citations preference -> citations');
s.mode = 'translation';
s.isBible = false;
eq(P.effectiveMode(s), 'citations', 'non-Bible forces citations regardless of preference');

// ---- selectMode ----
console.log('selectMode:');
s = fresh({ mode: 'translation' });
eq(P.selectMode(s, 'citations'), true, 'switching mode reports a change');
eq(s.mode, 'citations', '...and lands in the new mode');
eq(P.selectMode(s, 'citations'), false, 're-selecting the current mode is a no-op');
eq(P.selectMode(s, 'translation'), true, 'switching back reports a change');

s = fresh({ mode: 'translation' });
s.isBible = false;
eq(P.selectMode(s, 'citations'), false, 'mode clicks are ignored on non-Bible chapters');
eq(s.mode, 'translation', '...and the Bible-chapter preference is untouched');

s = fresh({ mode: 'translation' });
eq(P.selectMode(s, 'bogus'), false, 'a garbage mode click cannot corrupt state');
eq(s.mode, 'translation', '...and the mode is unchanged');

// ---- selectCitationView ----
console.log('selectCitationView:');
s = fresh({ mode: 'citations', citationView: 'source' });
eq(P.selectCitationView(s, 'verse'), true, 'switching layout in citations mode reports a change');
eq(s.citationView, 'verse', '...and lands on the new layout');
eq(P.selectCitationView(s, 'verse'), false, 're-selecting the current layout is a no-op');

s = fresh({ mode: 'translation', citationView: 'source' });
eq(P.selectCitationView(s, 'verse'), false, 'the layout toggle only acts while citations are showing');
eq(s.citationView, 'source', '...and the stored layout is untouched');

s = fresh({ mode: 'translation', citationView: 'source' });
s.isBible = false; // citations forced -> the toggle acts even though mode pref is translation
eq(P.selectCitationView(s, 'verse'), true, 'forced citations (non-Bible) counts as citations showing');

// ---- setBible ----
console.log('setBible:');
s = fresh({ mode: 'translation' });
eq(P.setBible(s, true), false, 'Bible -> Bible does not change the effective mode');
eq(P.setBible(s, false), true, 'Bible -> non-Bible flips effective mode to citations');
eq(P.effectiveMode(s), 'citations', '...effective mode is citations');
eq(s.mode, 'translation', '...but the Bible-chapter preference survives');
eq(P.setBible(s, true), true, 'non-Bible -> Bible restores the preferred mode (a change)');
eq(P.effectiveMode(s), 'translation', '...effective mode is translation again');

s = fresh({ mode: 'citations' });
eq(P.setBible(s, false), false, 'citations preference: Bible -> non-Bible is not an effective change');

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
