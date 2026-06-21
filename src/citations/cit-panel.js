/*
 * Citations mode: renders, for the current chapter, the talks/sermons that cite
 * its verses. Two layouts (chosen in settings, passed as opts.view):
 *   - 'verse'  : accordion verse -> source type -> talks. A citation that spans a
 *                verse range shows its full entry once (under the first verse of
 *                its range) and a slim labeled link under every other verse it
 *                spans, so it stays discoverable without repeating the snippet.
 *   - 'source' : one deduped row per citing source, grouped by source type, each
 *                tagged with the verse/range it cites.
 * Clicking an entry hands off to the inline talk reader via onOpenTalk.
 *
 * IIFE -> __BTX.citPanel.
 */
(function (root) {
  'use strict';

  const citData = () => root.__BTX.citData;

  const CORPUS_TAG = { G: 'GC', E: 'GC', J: 'JoD', T: 'JS' };

  // Source-type buckets shown as sub-dropdowns under each verse, in this order.
  // Each talk keeps its own CORPUS_TAG; E and G both count as General Conference.
  const GROUPS = [
    { key: 'gc', label: 'General Conference', corpora: ['G', 'E'] },
    { key: 'jod', label: 'Journal of Discourses', corpora: ['J'] },
    { key: 'tpjs', label: 'Teachings of the Prophet Joseph Smith', corpora: ['T'] },
  ];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // A <summary> with a custom caret, a label, and a right-aligned count chip.
  // countClass optionally tints the chip per source type (btx-grp-gc/jod/tpjs).
  function summaryRow(cls, labelText, count, countClass) {
    const sum = el('summary', cls);
    sum.appendChild(el('span', 'btx-caret'));
    sum.appendChild(el('span', 'btx-cit-label', labelText));
    sum.appendChild(el('span', 'btx-cit-count' + (countClass ? ' ' + countClass : ''), String(count)));
    return sum;
  }

  // Shorten the source label by dropping the part that the dropdown + tag already
  // convey (e.g. "October 2025 General Conference" -> "October 2025").
  function shortLabel(s) {
    const lbl = s.lbl || '';
    let out = lbl;
    if (s.c === 'G' || s.c === 'E') out = lbl.replace(/\s*General Conference\s*$/i, '').trim();
    else if (s.c === 'J') out = lbl.replace(/^Journal of Discourses\s*/i, '').trim();
    else if (s.c === 'T') out = lbl.replace(/^Teachings of the Prophet Joseph Smith,?\s*/i, '').trim();
    return out || s.d || '';
  }

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

  // First verse of each contiguous run in an ascending verse list, so a citation
  // shows once per range it cites: [3,4,5,10,11] -> [3,10]; [24,45,46] -> [24,45].
  function anchorVerses(vs) {
    const anchors = [];
    for (let i = 0; i < vs.length; i++) {
      if (i === 0 || vs[i] !== vs[i - 1] + 1) anchors.push(vs[i]);
    }
    return anchors;
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
  // ascending, so [0] is the first verse of the (possibly ranged) citation; ties
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

  // One talk row. opts.rangeLabel adds a verse/range badge (e.g. "vv. 3–6, 10–11")
  // for spanning citations and the by-source view.
  function entryRow(entry, onOpenTalk, opts) {
    opts = opts || {};
    const s = entry.source || {};
    const row = el('div', 'btx-cit');
    const head = el('div', 'btx-cit-head');
    const left = el('div', 'btx-cit-headl');
    left.appendChild(el('span', 'btx-cit-speaker', s.sp || 'Unknown'));
    if (opts.rangeLabel) left.appendChild(el('span', 'btx-cit-range', opts.rangeLabel));
    head.appendChild(left);
    head.appendChild(el('span', `btx-cit-tag btx-tag-${s.c || 'G'}`, CORPUS_TAG[s.c] || 'GC'));
    row.appendChild(head);
    const sub = [s.ti, shortLabel(s)].filter(Boolean).join(' · ');
    if (sub) row.appendChild(el('div', 'btx-cit-sub', sub));
    if (entry.snippet) row.appendChild(el('div', 'btx-cit-snippet', '“' + entry.snippet + '”'));
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const open = () => onOpenTalk && onOpenTalk(entry);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return row;
  }

  // Layout 'verse': verse -> source type -> talks. A spanning citation is shown
  // once at the first verse of each contiguous range it cites (anchorVerses), and
  // carries a badge of its full coverage (e.g. "vv. 3–6, 10–11"). When a verse has
  // a single source, its source-type group is pre-opened so one click on the verse
  // reveals the talk directly.
  function renderByVerse(wrap, data, fullName, chapter, focusVerse, onOpenTalk) {
    let focusEl = null;
    wrap.appendChild(el('div', 'btx-cit-summary',
      `${data.uniqueTotal} citation${data.uniqueTotal === 1 ? '' : 's'} in ${fullName || ''} ${chapter}`.trim()));

    for (const v of data.verseOrder) {
      const ids = data.byVerse[v] || [];
      const entries = ids
        .map((id) => data.entries[id])
        .filter((e) => e && anchorVerses(e.versesInChapter).includes(v));
      if (!entries.length) continue;

      // Verse-level dropdown, collapsed by default. Chip = citations anchored here.
      const vgroup = el('details', 'btx-cit-vgroup');
      vgroup.appendChild(summaryRow('btx-cit-vhead', `${v}`, entries.length));

      for (const g of GROUPS) {
        const items = entries.filter((e) => g.corpora.includes((e.source || {}).c));
        if (!items.length) continue;
        const cgroup = el('details', 'btx-cit-cgroup');
        cgroup.appendChild(summaryRow('btx-cit-chead', g.label, items.length, `btx-grp-${g.key}`));
        // Single source on this verse: open the source-type group so one click on
        // the verse reveals the talk (no second click on the source-type row).
        if (entries.length === 1) cgroup.open = true;
        for (const entry of items) {
          const multi = entry.versesInChapter.length > 1;
          cgroup.appendChild(entryRow(entry, onOpenTalk, multi ? { rangeLabel: verseLabel(entry.versesInChapter) } : undefined));
        }
        vgroup.appendChild(cgroup);
      }

      if (String(v) === String(focusVerse)) { vgroup.open = true; vgroup.classList.add('btx-cit-focus'); focusEl = vgroup; }
      wrap.appendChild(vgroup);
    }
    return focusEl;
  }

  // Layout 'source': one deduped row per source, grouped by source type, each
  // tagged with the verse/range it cites. Within each type, rows are ordered by
  // the first verse they cite (lowest at top). Collapsed by default (like by-verse).
  function renderBySource(wrap, data, fullName, chapter, onOpenTalk) {
    wrap.appendChild(el('div', 'btx-cit-summary',
      `${data.uniqueTotal} source${data.uniqueTotal === 1 ? '' : 's'} cite ${fullName || ''} ${chapter}`.trim()));

    const all = Object.values(data.entries).sort(byFirstVerse);
    for (const g of GROUPS) {
      const items = all.filter((e) => g.corpora.includes((e.source || {}).c));
      if (!items.length) continue;
      const group = el('details', 'btx-cit-vgroup');
      group.appendChild(summaryRow('btx-cit-vhead', g.label, items.length, `btx-grp-${g.key}`));
      const cgroup = el('div', 'btx-cit-cgroup');
      for (const entry of items) {
        cgroup.appendChild(entryRow(entry, onOpenTalk, { rangeLabel: verseLabel(entry.versesInChapter) }));
      }
      group.appendChild(cgroup);
      wrap.appendChild(group);
    }
    return null;
  }

  // Render the chapter's citations into bodyEl. Builds into a single wrapper that
  // is returned, so the orchestrator can cache + re-attach it (preserving scroll
  // and which dropdowns are open) when toggling between modes.
  // opts: { slug, chapter, fullName, focusVerse, onOpenTalk, view }
  async function render(bodyEl, opts) {
    const { slug, chapter, fullName, focusVerse, onOpenTalk, view } = opts;
    bodyEl.textContent = '';
    bodyEl.appendChild(el('div', 'btx-state-text btx-cit-loading', 'Loading citations…'));

    const data = await citData().chapterData(slug, chapter);

    const wrap = el('div', 'btx-cit-list');
    let focusEl = null;

    if (!data) {
      wrap.appendChild(el('p', 'btx-state-text', 'No citation data for this book.'));
    } else if (!data.verseOrder.length || data.uniqueTotal === 0) {
      wrap.appendChild(el('p', 'btx-state-text', `No talks cite ${fullName || ''} ${chapter}.`.trim()));
    } else if (view === 'source') {
      focusEl = renderBySource(wrap, data, fullName, chapter, onOpenTalk);
    } else {
      focusEl = renderByVerse(wrap, data, fullName, chapter, focusVerse, onOpenTalk);
    }

    bodyEl.textContent = '';
    bodyEl.appendChild(wrap);
    if (focusEl) requestAnimationFrame(() => { bodyEl.scrollTop = Math.max(0, focusEl.offsetTop - 50); });
    return wrap;
  }

  root.__BTX = Object.assign(root.__BTX || {}, { citPanel: { render } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
