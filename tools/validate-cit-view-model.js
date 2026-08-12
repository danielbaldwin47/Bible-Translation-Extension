#!/usr/bin/env node
/*
 * Exercise the pure citation view-model. Run: node tools/validate-cit-view-model.js
 *
 * The view-model turns chapterData into descriptors (verse groups, source-type
 * groups, citation rows) with no DOM involved, so the decisions the panel used
 * to make while calling createElement are checkable here: anchor-verse dedup,
 * both citation-layout orderings, the single-source pre-open rule, range and
 * summary labels, and the filter / expand-all state transitions.
 *
 * Exits non-zero on any failure so it can gate a commit.
 */
'use strict';

const path = require('path');
const VM = require(path.resolve(__dirname, '..', 'src', 'citations', 'cit-view-model.js'));

let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); failures++; }
}
const eq = (a, b, msg) => check(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const deep = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Every collapsible group in the tree (verse groups plus their source-type
// groups), and the cites still showing under a plan — the panel walks the same
// two shapes when it mirrors a plan onto the DOM.
const allGroups = (view) => view.groups.reduce((acc, g) => acc.concat([g], g.children), []);
const visibleRowIds = (view, plan) =>
  VM.allRows(view).filter((r) => !plan.hidden[r.uid]).map((r) => r.citId);

// --- fixtures -------------------------------------------------------------
// Shape mirrors citData.chapterData: entries keyed by citId, each carrying its
// in-chapter verse span, plus a verse -> citId index.
function makeData(cites) {
  const byVerse = {};
  const entries = {};
  for (const c of cites) {
    entries[c.citId] = {
      citId: c.citId,
      talkId: c.talkId || 't-' + c.citId,
      versesInChapter: c.verses,
      snippet: c.snippet || '',
      source: c.source,
    };
    for (const v of c.verses) (byVerse[v] = byVerse[v] || []).push(c.citId);
  }
  const verseOrder = Object.keys(byVerse).map(Number).sort((a, b) => a - b);
  return { verseOrder, byVerse, entries, uniqueTotal: cites.length };
}

const gc = (sp, ti, d) => ({ c: 'G', sp, ti, d, lbl: `${d} General Conference` });
const jod = (sp, ti, d) => ({ c: 'J', sp, ti, d, lbl: `Journal of Discourses, vol. 4` });
const tpjs = (sp, ti, d) => ({ c: 'T', sp, ti, d, lbl: `Teachings of the Prophet Joseph Smith, ch. 2` });

const OPTS = { view: 'verse', fullName: 'John', chapter: 3 };

// --- pure helpers ---------------------------------------------------------
console.log('Helpers:');
deep(VM.anchorVerses([3, 4, 5, 10, 11]), [3, 10], 'anchorVerses splits contiguous ranges');
deep(VM.anchorVerses([24, 45, 46]), [24, 45], 'anchorVerses on a gap');
deep(VM.anchorVerses([16]), [16], 'anchorVerses of a single verse');
deep(VM.anchorVerses([]), [], 'anchorVerses of an empty span');

eq(VM.formatVerses([3, 4, 5, 6, 7, 8, 9, 10]), '3–10', 'formatVerses collapses a run');
eq(VM.formatVerses([24, 45, 46]), '24, 45–46', 'formatVerses mixes singles and runs');
eq(VM.formatVerses([]), '', 'formatVerses of nothing');
eq(VM.verseLabel([16]), 'v. 16', 'verseLabel singular');
eq(VM.verseLabel([3, 4]), 'vv. 3–4', 'verseLabel plural');
eq(VM.verseLabel([3, 4, 5, 6, 10, 11]), 'vv. 3–6, 10–11', 'verseLabel of a split range');

// --- by-verse layout ------------------------------------------------------
console.log('By-verse layout:');
{
  const data = makeData([
    { citId: 'a', verses: [3, 4, 5], source: gc('Nelson', 'Born Again', '2020-04'), snippet: 'water and spirit' },
    { citId: 'b', verses: [4], source: jod('Young', 'On Rebirth', '1857-07') },
    { citId: 'c', verses: [16], source: gc('Oaks', 'God So Loved', '2021-10') },
  ]);
  const view = VM.buildView(data, OPTS);

  eq(view.layout, 'verse', 'layout is by verse');
  eq(view.empty, false, 'not empty');
  // Anchor-verse dedup: cite "a" spans 3–5 but anchors only at 3, so verse 5
  // (mid-range, nothing else on it) yields no verse group at all.
  deep(view.groups.map((g) => g.label), ['3', '4', '16'], 'a verse group per verse with an anchored cite');

  const v3 = view.groups[0], v4 = view.groups[1];
  deep(v3.children.flatMap((c) => c.rows.map((r) => r.citId)), ['a'], 'v3 holds the spanning cite');
  deep(v4.children.flatMap((c) => c.rows.map((r) => r.citId)), ['b'], 'v4 holds only its own cite, not the spanning one');

  eq(v3.count, 1, 'verse chip counts anchored cites');
  eq(v3.children[0].label, 'General Conference', 'source-type group label');
  eq(v3.children[0].countClass, 'btx-grp-gc', 'source-type chip class');

  // Pre-open rule: single cite on the verse -> its source-type group starts open.
  eq(v3.children[0].open, true, 'single-source verse pre-opens its source-type group');
  eq(v3.open, false, 'verse groups still start collapsed');

  // Range badge only on spanning cites.
  eq(v3.children[0].rows[0].rangeLabel, 'vv. 3–5', 'spanning cite carries its range label');
  eq(v4.children[0].rows[0].rangeLabel, null, 'single-verse cite has no range label');

  // Row descriptor content.
  const row = v3.children[0].rows[0];
  eq(row.speaker, 'Nelson', 'row speaker');
  eq(row.tag, 'GC', 'corpus tag text');
  eq(row.tagClass, 'btx-tag-G', 'corpus tag class');
  eq(row.sub, 'Born Again · 2020-04', 'sub line drops the redundant "General Conference"');
  eq(row.snippet, 'water and spirit', 'snippet passes through');
  eq(row.search, 'nelson born again 2020-04 general conference water and spirit', 'filter haystack is lowercased');
  eq(row.entry, data.entries.a, 'row keeps its entry for the talk reader');
}

{
  // A cite covering two contiguous ranges anchors twice: it is listed under
  // verse 3 and again under verse 10, each time badged with its full coverage,
  // and the two rows must not collide on one uid.
  const data = makeData([
    { citId: 'a', verses: [3, 4, 5, 10, 11], source: gc('Holland', 'Born of Water', '2015-04') },
    { citId: 'b', verses: [10], source: gc('Bednar', 'Converted', '2019-10') },
  ]);
  const view = VM.buildView(data, OPTS);
  deep(view.groups.map((g) => g.label), ['3', '10'], 'one verse group per anchor verse');
  deep(view.groups[0].children[0].rows.map((r) => r.citId), ['a'], 'first range anchors at v3');
  deep(view.groups[1].children[0].rows.map((r) => r.citId), ['a', 'b'], 'second range anchors at v10');
  eq(view.groups[0].children[0].rows[0].rangeLabel, 'vv. 3–5, 10–11', 'both anchors badge full coverage');
  eq(view.groups[1].children[0].rows[0].rangeLabel, 'vv. 3–5, 10–11', 'including the second one');
  eq(view.groups[0].count, 1, 'v3 chip counts only what anchors there');
  eq(view.groups[1].count, 2, 'v10 chip counts both');
  eq(view.groups[0].children[0].open, true, 'v3 is single-source -> pre-opened');
  eq(view.groups[1].children[0].open, false, 'v10 has two cites -> not pre-opened');

  const rowUids = VM.allRows(view).map((r) => r.uid);
  eq(new Set(rowUids).size, rowUids.length, 'the twice-anchored cite gets two distinct row uids');
  eq(new Set(allGroups(view).map((g) => g.uid)).size, allGroups(view).length, 'group uids are unique');
}

{
  // Two cites on one verse -> no pre-open; source-type groups in GC/JoD/TPJS order.
  const data = makeData([
    { citId: 'a', verses: [16], source: jod('Young', 'A', '1857-07') },
    { citId: 'b', verses: [16], source: tpjs('Smith', 'B', '1843-01') },
    { citId: 'c', verses: [16], source: gc('Oaks', 'C', '2021-10') },
  ]);
  const g = VM.buildView(data, OPTS).groups[0];
  eq(g.count, 3, 'verse chip counts all three');
  deep(g.children.map((c) => c.key), ['gc', 'jod', 'tpjs'], 'source-type groups keep their fixed order');
  eq(g.children.every((c) => c.open === false), true, 'multi-source verse pre-opens nothing');
  deep(g.children.map((c) => c.count), [1, 1, 1], 'per-source-type counts');
}

{
  // focusVerse opens and marks its verse group.
  const data = makeData([
    { citId: 'a', verses: [3], source: gc('A', 'T', '2020-04') },
    { citId: 'b', verses: [16], source: gc('B', 'T', '2020-04') },
  ]);
  const view = VM.buildView(data, Object.assign({}, OPTS, { focusVerse: 16 }));
  const [v3, v16] = view.groups;
  eq(v16.open, true, 'focus verse group starts open');
  eq(v16.focus, true, 'focus verse group is marked');
  eq(v3.focus, false, 'other verse groups are not');
  eq(view.focusUid, v16.uid, 'view names the focus group');
}

// --- by-source layout -----------------------------------------------------
console.log('By-source layout:');
{
  const data = makeData([
    { citId: 'a', verses: [16], source: gc('Late', 'T', '2021-10') },
    { citId: 'b', verses: [3, 4], source: gc('Early', 'T', '1999-04') },
    { citId: 'c', verses: [3, 4], source: gc('Newer', 'T', '2015-04') },
    { citId: 'd', verses: [5], source: jod('Young', 'T', '1857-07') },
  ]);
  const view = VM.buildView(data, { view: 'source', fullName: 'John', chapter: 3 });

  eq(view.layout, 'source', 'layout is by source');
  deep(view.groups.map((g) => g.key), ['gc', 'jod'], 'only non-empty source-type groups, in order');
  deep(view.groups[0].rows.map((r) => r.citId), ['c', 'b', 'a'],
    'rows order by first cited verse, newest-first on identical ranges');
  eq(view.groups[0].children.length, 0, 'by-source groups hold rows directly');
  eq(view.groups[0].rows[0].rangeLabel, 'vv. 3–4', 'every by-source row is range-labelled');
  eq(view.groups[0].rows[2].rangeLabel, 'v. 16', 'single-verse row is labelled too');
  eq(view.groups[0].count, 3, 'source-type chip counts its rows');
  eq(view.groups[0].open, false, 'by-source groups start collapsed');
}

// --- summary line + toolbar gate -----------------------------------------
console.log('Summary line:');
{
  const one = makeData([{ citId: 'a', verses: [16], source: gc('A', 'T', '2020-04') }]);
  eq(VM.buildView(one, OPTS).summary, '1 citation in John 3', 'singular, by verse');
  eq(VM.buildView(one, { view: 'source', fullName: 'John', chapter: 3 }).summary,
    '1 source cites John 3', 'singular, by source');

  const three = makeData([
    { citId: 'a', verses: [3], source: gc('A', 'T', '2020-04') },
    { citId: 'b', verses: [4], source: gc('B', 'T', '2020-04') },
    { citId: 'c', verses: [5], source: gc('C', 'T', '2020-04') },
  ]);
  eq(VM.buildView(three, OPTS).summary, '3 citations in John 3', 'plural, by verse');
  eq(VM.buildView(three, { view: 'source', fullName: 'John', chapter: 3 }).summary,
    '3 sources cite John 3', 'plural, by source');
  eq(VM.buildView(three, OPTS).showTools, false, 'toolbar hidden below 4 cites');

  const four = makeData([3, 4, 5, 6].map((v) => ({ citId: 'c' + v, verses: [v], source: gc('S', 'T', '2020-04') })));
  eq(VM.buildView(four, OPTS).showTools, true, 'toolbar shown from 4 cites');
}

console.log('Empty states:');
{
  const none = VM.buildView(null, OPTS);
  eq(none.empty, true, 'null data is empty');
  eq(none.emptyText, 'No citation data for this book.', 'no shard for the book');
  deep(none.groups, [], 'no groups');

  const zero = VM.buildView({ verseOrder: [], byVerse: {}, entries: {}, uniqueTotal: 0 }, OPTS);
  eq(zero.empty, true, 'zero cites is empty');
  eq(zero.emptyText, 'No talks cite John 3.', 'chapter with no citing talks');
  eq(zero.summary, null, 'no summary line when empty');
}

// --- filter + expand/collapse-all ----------------------------------------
console.log('Toolbar state:');
{
  const data = makeData([
    { citId: 'a', verses: [3], source: gc('Nelson', 'Born Again', '2020-04'), snippet: 'water and spirit' },
    { citId: 'b', verses: [4], source: jod('Young', 'On Rebirth', '1857-07'), snippet: 'the new birth' },
    { citId: 'c', verses: [16], source: gc('Oaks', 'God So Loved', '2021-10'), snippet: 'only begotten' },
    { citId: 'd', verses: [17], source: gc('Nelson', 'Condemn Not', '2019-10'), snippet: 'to save the world' },
  ]);
  const view = VM.buildView(data, OPTS);
  const state = VM.initialState(view);

  eq(allGroups(view).length, 8, 'four verse groups plus one source-type group each');
  eq(Object.keys(state.open).length, 8, 'initial open state covers every collapsible group');
  eq(state.preFilterOpen, null, 'no captured state before filtering');

  // The user opens verse 3 by hand.
  const v3 = view.groups[0];
  state.open[v3.uid] = true;

  // Filtering: non-matching rows and now-empty groups hide; survivors open.
  const plan = VM.filterPlan(view, 'nelson', state);
  eq(plan.filtering, true, 'a non-empty query filters');
  eq(plan.anyMatch, true, 'nelson matches');
  deep(visibleRowIds(view,plan), ['a', 'd'], 'only Nelson rows survive');
  eq(plan.hidden[view.groups[1].uid], true, 'the verse group with no surviving row hides');
  eq(plan.hidden[view.groups[0].uid], false, 'the verse group with a survivor stays');
  eq(plan.open[view.groups[3].uid], true, 'surviving groups open so matches are visible');
  eq(plan.preFilterOpen[v3.uid], true, 'pre-filter open state is captured');
  eq(plan.preFilterOpen[view.groups[1].uid], false, 'including the closed groups');
  eq(plan.toggleLabel, 'Collapse all', 'everything visible is open while filtering');

  // A second keystroke keeps the originally captured state, not the filtered one.
  const state2 = VM.applyPlan(state, plan);
  const plan2 = VM.filterPlan(view, 'nelsonx', state2);
  eq(plan2.anyMatch, false, 'no row matches');
  deep(visibleRowIds(view,plan2), [], 'nothing visible');
  eq(plan2.preFilterOpen[v3.uid], true, 'the first capture is not overwritten by filtered opens');

  // Clearing restores the pre-filter open state and drops the capture.
  const plan3 = VM.filterPlan(view, '', VM.applyPlan(state2, plan2));
  eq(plan3.filtering, false, 'empty query stops filtering');
  eq(plan3.open[v3.uid], true, 'the hand-opened group stays open');
  eq(plan3.open[view.groups[3].uid], false, 'groups opened only by the filter close again');
  eq(plan3.preFilterOpen, null, 'the capture is released');
  deep(visibleRowIds(view,plan3), ['a', 'b', 'c', 'd'], 'all rows visible again');

  // Expand-all / collapse-all acts on visible groups only.
  const cleared = VM.applyPlan(state2, plan3);
  const expand = VM.toggleAllPlan(view, cleared);
  eq(expand.expand, true, 'some group is closed -> expand');
  eq(Object.values(expand.open).every(Boolean), true, 'every visible group opens');
  eq(VM.toggleLabel(view, VM.applyPlan(cleared, expand)), 'Collapse all', 'label flips once all are open');
  const collapse = VM.toggleAllPlan(view, VM.applyPlan(cleared, expand));
  eq(collapse.expand, false, 'all open -> collapse');
  eq(Object.values(collapse.open).some(Boolean), false, 'every visible group closes');
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
