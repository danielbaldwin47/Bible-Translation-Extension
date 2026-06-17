/*
 * Citations mode: renders, for the current chapter, the talks/sermons that cite
 * each verse — grouped by verse, newest first, with a context snippet. Clicking
 * an entry hands off to the inline talk reader via the onOpenTalk callback.
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

  function entryRow(entry, onOpenTalk) {
    const s = entry.source || {};
    const row = el('div', 'btx-cit');
    const head = el('div', 'btx-cit-head');
    head.appendChild(el('span', 'btx-cit-speaker', s.sp || 'Unknown'));
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

  // Render the chapter's citations into bodyEl. Builds into a single wrapper that
  // is returned, so the orchestrator can cache + re-attach it (preserving scroll
  // and which dropdowns are open) when toggling between modes.
  // opts: { slug, chapter, fullName, focusVerse, onOpenTalk }
  async function render(bodyEl, opts) {
    const { slug, chapter, fullName, focusVerse, onOpenTalk } = opts;
    bodyEl.textContent = '';
    bodyEl.appendChild(el('div', 'btx-state-text btx-cit-loading', 'Loading citations…'));

    const data = await citData().chapterCitations(slug, chapter);

    const wrap = el('div', 'btx-cit-list');
    let focusEl = null;

    if (!data) {
      wrap.appendChild(el('p', 'btx-state-text', 'No citation data for this book.'));
    } else {
      const verses = Object.keys(data.byVerse).map(Number).sort((a, b) => a - b);
      if (!verses.length || data.total === 0) {
        wrap.appendChild(el('p', 'btx-state-text', `No talks cite ${fullName || ''} ${chapter}.`.trim()));
      } else {
        wrap.appendChild(el('div', 'btx-cit-summary', `${data.total} citation${data.total === 1 ? '' : 's'} in ${fullName || ''} ${chapter}`.trim()));
        for (const v of verses) {
          const entries = data.byVerse[v];
          if (!entries || !entries.length) continue;

          // Verse-level dropdown, collapsed by default.
          const vgroup = el('details', 'btx-cit-vgroup');
          vgroup.appendChild(summaryRow('btx-cit-vhead', `${v}`, entries.length));

          // Bucket this verse's entries (already newest-first) by source type.
          for (const g of GROUPS) {
            const items = entries.filter((e) => g.corpora.includes((e.source || {}).c));
            if (!items.length) continue;
            const cgroup = el('details', 'btx-cit-cgroup');
            cgroup.appendChild(summaryRow('btx-cit-chead', g.label, items.length, `btx-grp-${g.key}`));
            for (const entry of items) cgroup.appendChild(entryRow(entry, onOpenTalk));
            vgroup.appendChild(cgroup);
          }

          if (String(v) === String(focusVerse)) { vgroup.open = true; vgroup.classList.add('btx-cit-focus'); focusEl = vgroup; }
          wrap.appendChild(vgroup);
        }
      }
    }

    bodyEl.textContent = '';
    bodyEl.appendChild(wrap);
    if (focusEl) requestAnimationFrame(() => { bodyEl.scrollTop = Math.max(0, focusEl.offsetTop - 50); });
    return wrap;
  }

  root.__BTX = Object.assign(root.__BTX || {}, { citPanel: { render } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
