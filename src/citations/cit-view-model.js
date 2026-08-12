/*
 * Pure view-model for Citations mode: chapter data in, descriptors out. No DOM.
 *
 *   citData.chapterData(slug, chapter)  ->  buildView(data, opts)  ->  cit-panel
 *
 * Every decision the panel used to make while building elements lives here:
 * which cites anchor at which verse, the corpus -> source-type bucketing, both
 * citation-layout orderings, the single-source pre-open rule, the range badges
 * and summary-line grammar, and the filter / expand-all state transitions.
 * cit-panel is a thin adapter from these descriptors to elements, which keeps
 * this module reachable from Node (tools/validate-cit-view-model.js). What the
 * adapter still owns is fixed chrome that depends on no data: the loading and
 * no-results lines, the filter placeholder, and the quote marks around a
 * snippet.
 *
 * Descriptor tree (uids are stable within one built view-model, so the adapter
 * can map element <-> descriptor and the toolbar can key its state off them):
 *
 *   viewModel { layout, empty, emptyText, summary, showTools, groups, focusUid }
 *   group { uid, kind:'verse'|'sourceType', key, label, count, countClass,
 *           open, focus, children:[group], rows:[row] }
 *   row   { uid, citId, speaker, tag, tagClass, rangeLabel, sub, snippet,
 *           search, entry }
 *
 * By-verse fills group.children (verse -> source-type group -> rows); by-source
 * hangs rows straight off one group per source type. Only groups are
 * collapsible; rows never are.
 *
 * IIFE -> __BTX.citVM (+ module.exports for the Node validator).
 */
(function (root) {
  'use strict';

  const CORPUS_TAG = { G: 'GC', E: 'GC', J: 'JoD', T: 'JS' };

  // Source-type buckets, in display order. Each talk keeps its own CORPUS_TAG;
  // E and G both count as General Conference.
  const SOURCE_TYPES = [
    { key: 'gc', label: 'General Conference', corpora: ['G', 'E'] },
    { key: 'jod', label: 'Journal of Discourses', corpora: ['J'] },
    { key: 'tpjs', label: 'Teachings of the Prophet Joseph Smith', corpora: ['T'] },
  ];

  // --- pure helpers --------------------------------------------------------

  // Collapse an ascending list of verse numbers into runs: [3..10] -> "3–10",
  // [24,45,46] -> "24, 45–46".
  function formatVerses(vs) {
    if (!vs || !vs.length) return '';
    const parts = [];
    let start = vs[0], prev = vs[0];
    for (let i = 1; i <= vs.length; i++) {
      const cur = vs[i];
      if (cur === prev + 1) { prev = cur; continue; }
      parts.push(start === prev ? String(start) : `${start}–${prev}`);
      start = cur; prev = cur;
    }
    return parts.join(', ');
  }

  function verseLabel(vs) {
    return (vs && vs.length > 1 ? 'vv. ' : 'v. ') + formatVerses(vs);
  }

  // First verse of each contiguous range in an ascending verse list, so a cite
  // shows once per range it cites: [3,4,5,10,11] -> [3,10]; [24,45,46] -> [24,45].
  function anchorVerses(vs) {
    const anchors = [];
    if (!vs) return anchors;
    for (let i = 0; i < vs.length; i++) {
      if (i === 0 || vs[i] !== vs[i - 1] + 1) anchors.push(vs[i]);
    }
    return anchors;
  }

  // Shorten the source label by dropping the part the group + tag already
  // convey (e.g. "October 2025 General Conference" -> "October 2025").
  function shortLabel(s) {
    const lbl = s.lbl || '';
    let out = lbl;
    if (s.c === 'G' || s.c === 'E') out = lbl.replace(/\s*General Conference\s*$/i, '').trim();
    else if (s.c === 'J') out = lbl.replace(/^Journal of Discourses\s*/i, '').trim();
    else if (s.c === 'T') out = lbl.replace(/^Teachings of the Prophet Joseph Smith,?\s*/i, '').trim();
    return out || s.d || '';
  }

  // Newest-first by source date ("YYYY-MM"); undated entries sort last.
  function byDateDesc(a, b) {
    const da = (a.source || {}).d || '';
    const db = (b.source || {}).d || '';
    if (da === db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da < db ? 1 : -1;
  }

  // By first cited in-chapter verse, lowest at the top. versesInChapter is
  // ascending, so [0] is the first verse of the (possibly ranged) cite; ties
  // fall through to the rest of the range, then newest-first for identical ranges.
  function byFirstVerse(a, b) {
    const va = a.versesInChapter || [];
    const vb = b.versesInChapter || [];
    const n = Math.min(va.length, vb.length);
    for (let i = 0; i < n; i++) {
      if (va[i] !== vb[i]) return va[i] - vb[i];
    }
    if (va.length !== vb.length) return va.length - vb.length;
    return byDateDesc(a, b);
  }

  const sourceTypeOf = (entry) =>
    SOURCE_TYPES.find((g) => g.corpora.includes((entry.source || {}).c));

  // --- descriptors ---------------------------------------------------------

  // uid is position-derived so it stays unique even if one group ever holds the
  // same cite twice; the same cite under two anchor verses gets two rows, two uids.
  function rowDesc(entry, uidPrefix, i, rangeLabel) {
    const s = entry.source || {};
    const sub = [s.ti, shortLabel(s)].filter(Boolean).join(' · ');
    return {
      uid: `${uidPrefix}/${i}:${entry.citId}`,
      citId: entry.citId,
      speaker: s.sp || 'Unknown',
      tag: CORPUS_TAG[s.c] || 'GC',
      tagClass: `btx-tag-${s.c || 'G'}`,
      rangeLabel: rangeLabel || null,
      sub: sub || null,
      snippet: entry.snippet || '',
      search: [s.sp, s.ti, s.lbl, entry.snippet].filter(Boolean).join(' ').toLowerCase(),
      entry,
    };
  }

  function groupDesc(fields) {
    return Object.assign({
      uid: '', kind: 'verse', key: '', label: '', count: 0, countClass: null,
      open: false, focus: false, children: [], rows: [],
    }, fields);
  }

  // Layout 'verse': verse -> source-type group -> rows. A spanning cite is
  // listed once at each of its anchor verses and carries a badge of its full
  // coverage (e.g. "vv. 3–6, 10–11"). A verse with a single cite pre-opens its
  // source-type group, so one click on the verse reveals the talk.
  function verseGroups(data, focusVerse) {
    const groups = [];
    for (const v of data.verseOrder) {
      const entries = (data.byVerse[v] || [])
        .map((id) => data.entries[id])
        .filter((e) => e && anchorVerses(e.versesInChapter).includes(v));
      if (!entries.length) continue;

      const uid = `v:${v}`;
      const focus = focusVerse != null && String(v) === String(focusVerse);
      const children = [];
      for (const t of SOURCE_TYPES) {
        const items = entries.filter((e) => sourceTypeOf(e) === t);
        if (!items.length) continue;
        const childUid = `${uid}/${t.key}`;
        children.push(groupDesc({
          uid: childUid,
          kind: 'sourceType',
          key: t.key,
          label: t.label,
          count: items.length,
          countClass: `btx-grp-${t.key}`,
          open: entries.length === 1,
          rows: items.map((e, i) => rowDesc(
            e, childUid, i, e.versesInChapter.length > 1 ? verseLabel(e.versesInChapter) : null)),
        }));
      }

      groups.push(groupDesc({
        uid, kind: 'verse', key: String(v), label: String(v),
        count: entries.length, open: focus, focus, children,
      }));
    }
    return groups;
  }

  // Layout 'source': one deduped row per citing talk, grouped by source type,
  // each tagged with the verse/range it cites and ordered by first cited verse.
  function sourceGroups(data) {
    const all = Object.values(data.entries).sort(byFirstVerse);
    const groups = [];
    for (const t of SOURCE_TYPES) {
      const items = all.filter((e) => sourceTypeOf(e) === t);
      if (!items.length) continue;
      const uid = `s:${t.key}`;
      groups.push(groupDesc({
        uid, kind: 'sourceType', key: t.key, label: t.label,
        count: items.length, countClass: `btx-grp-${t.key}`,
        rows: items.map((e, i) => rowDesc(e, uid, i, verseLabel(e.versesInChapter))),
      }));
    }
    return groups;
  }

  // opts: { view: 'verse'|'source', fullName, chapter, focusVerse }
  // data: citData.chapterData(...) — null when the book has no shard.
  function buildView(data, opts) {
    opts = opts || {};
    const layout = opts.view === 'source' ? 'source' : 'verse';
    const where = `${opts.fullName || ''} ${opts.chapter}`.trim();

    if (!data || !data.verseOrder.length || data.uniqueTotal === 0) {
      return {
        layout, empty: true,
        emptyText: !data ? 'No citation data for this book.' : `No talks cite ${where}.`.trim(),
        summary: null, showTools: false, groups: [], focusUid: null,
      };
    }

    const total = data.uniqueTotal;
    const noun = layout === 'source' ? 'source' : 'citation';
    const verb = layout === 'source' ? (total === 1 ? ' cites' : ' cite') : ' in';
    const groups = layout === 'source' ? sourceGroups(data) : verseGroups(data, opts.focusVerse);
    const focused = groups.find((g) => g.focus);

    return {
      layout,
      empty: false,
      emptyText: null,
      summary: `${total} ${noun}${total === 1 ? '' : 's'}${verb} ${where}`.trim(),
      showTools: total >= 4,
      groups,
      focusUid: focused ? focused.uid : null,
    };
  }

  // --- toolbar state -------------------------------------------------------
  // The filter box and expand/collapse-all button used to read the live DOM.
  // Instead they run on a plain state object — { open: {uid:bool},
  // preFilterOpen: {uid:bool}|null } — and the adapter mirrors it onto the
  // <details> elements. Plans are computed, not applied, so the transitions
  // (which groups hide, which open, what the button says, what a cleared filter
  // restores) are checkable without a document.

  function eachGroup(viewModel, fn) {
    for (const g of viewModel.groups) {
      fn(g);
      for (const c of g.children) fn(c);
    }
  }

  function initialState(viewModel) {
    const open = {};
    eachGroup(viewModel, (g) => { open[g.uid] = g.open; });
    return { open, preFilterOpen: null };
  }

  function rowsOf(group) {
    return group.rows.concat(group.children.reduce((acc, c) => acc.concat(c.rows), []));
  }

  // Hides rows that miss the query and groups left with no visible row, opens
  // the survivors, and — on the transition into filtering — captures the open
  // state so clearing the box can restore it.
  function filterPlan(viewModel, query, state) {
    const q = String(query || '').trim().toLowerCase();
    const filtering = q.length > 0;
    const hidden = {};
    const open = {};
    let anyMatch = false;

    for (const g of viewModel.groups) {
      for (const row of rowsOf(g)) {
        const hit = !filtering || row.search.includes(q);
        hidden[row.uid] = !hit;
        if (hit) anyMatch = true;
      }
    }

    const preFilterOpen = filtering
      ? (state.preFilterOpen || Object.assign({}, state.open))
      : null;

    eachGroup(viewModel, (g) => {
      const visible = !filtering || rowsOf(g).some((r) => !hidden[r.uid]);
      hidden[g.uid] = !visible;
      if (filtering) open[g.uid] = visible ? true : state.open[g.uid];
      else open[g.uid] = state.preFilterOpen ? state.preFilterOpen[g.uid] : state.open[g.uid];
    });

    const plan = { filtering, anyMatch, hidden, open, preFilterOpen };
    plan.toggleLabel = toggleLabel(viewModel, { open }, hidden);
    return plan;
  }

  // Fold a plan back into the state the adapter carries between interactions.
  function applyPlan(state, plan) {
    return {
      open: Object.assign({}, state.open, plan.open),
      preFilterOpen: 'preFilterOpen' in plan ? plan.preFilterOpen : state.preFilterOpen,
    };
  }

  const visibleGroups = (viewModel, hidden) => {
    const out = [];
    eachGroup(viewModel, (g) => { if (!hidden || !hidden[g.uid]) out.push(g); });
    return out;
  };

  // Any visible group still closed -> the button expands; otherwise it collapses.
  function toggleAllPlan(viewModel, state, hidden) {
    const groups = visibleGroups(viewModel, hidden);
    const expand = groups.some((g) => !state.open[g.uid]);
    const open = {};
    for (const g of groups) open[g.uid] = expand;
    return { expand, open };
  }

  function toggleLabel(viewModel, state, hidden) {
    return visibleGroups(viewModel, hidden).some((g) => !state.open[g.uid]) ? 'Expand all' : 'Collapse all';
  }

  // Every citation row in the tree, in display order. The adapter uses it to
  // walk what a plan hides; the corpus tables, comparators and label helpers
  // above stay module-private — they are reachable through buildView.
  function allRows(viewModel) {
    const rows = [];
    for (const g of viewModel.groups) rows.push.apply(rows, rowsOf(g));
    return rows;
  }

  const VM = {
    formatVerses, verseLabel, anchorVerses,
    buildView,
    initialState, filterPlan, applyPlan, toggleAllPlan, toggleLabel, allRows,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = VM;
  root.__BTX = Object.assign(root.__BTX || {}, { citVM: VM });
})(typeof globalThis !== 'undefined' ? globalThis : this);
