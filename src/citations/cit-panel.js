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

  const CORPUS_TAG = { G: 'GC', E: 'GC', J: 'JoD', T: 'TPJS' };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function entryRow(entry, onOpenTalk) {
    const s = entry.source || {};
    const row = el('div', 'btx-cit');
    const head = el('div', 'btx-cit-head');
    head.appendChild(el('span', 'btx-cit-speaker', s.sp || 'Unknown'));
    head.appendChild(el('span', `btx-cit-tag btx-tag-${s.c || 'G'}`, CORPUS_TAG[s.c] || 'GC'));
    row.appendChild(head);
    const sub = [s.ti, s.lbl || s.d].filter(Boolean).join(' · ');
    if (sub) row.appendChild(el('div', 'btx-cit-sub', sub));
    if (entry.snippet) row.appendChild(el('div', 'btx-cit-snippet', '“' + entry.snippet + '”'));
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const open = () => onOpenTalk && onOpenTalk(entry);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return row;
  }

  // Render the chapter's citations into bodyEl.
  // opts: { slug, chapter, fullName, focusVerse, onOpenTalk }
  async function render(bodyEl, opts) {
    const { slug, chapter, fullName, focusVerse, onOpenTalk } = opts;
    bodyEl.textContent = '';
    bodyEl.appendChild(el('div', 'btx-state-text btx-cit-loading', 'Loading citations…'));

    const data = await citData().chapterCitations(slug, chapter);
    bodyEl.textContent = '';

    if (!data) {
      bodyEl.appendChild(el('p', 'btx-state-text', 'No citation data for this book.'));
      return;
    }
    const verses = Object.keys(data.byVerse).map(Number).sort((a, b) => a - b);
    if (!verses.length || data.total === 0) {
      bodyEl.appendChild(el('p', 'btx-state-text', `No talks cite ${fullName || ''} ${chapter}.`.trim()));
      return;
    }

    bodyEl.appendChild(el('div', 'btx-cit-summary', `${data.total} citation${data.total === 1 ? '' : 's'} in ${fullName || ''} ${chapter}`.trim()));

    let focusEl = null;
    for (const v of verses) {
      const entries = data.byVerse[v];
      if (!entries || !entries.length) continue;
      const group = el('div', 'btx-cit-group');
      if (String(v) === String(focusVerse)) group.classList.add('btx-cit-focus');
      const vh = el('div', 'btx-cit-vhead');
      vh.appendChild(el('span', 'btx-cit-vnum', `Verse ${v}`));
      vh.appendChild(el('span', 'btx-cit-vcount', String(entries.length)));
      group.appendChild(vh);
      for (const entry of entries) group.appendChild(entryRow(entry, onOpenTalk));
      bodyEl.appendChild(group);
      if (String(v) === String(focusVerse)) focusEl = group;
    }

    if (focusEl) requestAnimationFrame(() => { bodyEl.scrollTop = Math.max(0, focusEl.offsetTop - 50); });
  }

  root.__BTX = Object.assign(root.__BTX || {}, { citPanel: { render } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
