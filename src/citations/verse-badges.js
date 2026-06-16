/*
 * Per-verse citation badges: a small count chip injected next to each verse in
 * the Church's reading text. Clicking a chip opens the panel's Citations mode
 * focused on that verse. Verses on scripture pages render as elements whose id
 * is `p{verseNumber}` (e.g. p16); we locate them within the reading container.
 *
 * IIFE -> __BTX.verseBadges.
 */
(function (root) {
  'use strict';

  const citData = () => root.__BTX.citData;
  const theme = () => root.__BTX.theme;

  const BADGE_CLASS = 'btx-verse-badge';
  let retryTimer = null;

  function clear() {
    clearTimeout(retryTimer);
    document.querySelectorAll('.' + BADGE_CLASS).forEach((n) => n.remove());
  }

  function readingRoot() {
    try {
      const c = theme().resolveReadingContainer();
      // climb to a container that holds multiple verses
      return (c && c.closest && (c.closest('article') || c.closest('main'))) || c || document.body;
    } catch (e) { return document.body; }
  }

  function inject(counts, onVerseClick) {
    const root2 = readingRoot();
    if (!root2) return 0;
    let added = 0;
    const nodes = root2.querySelectorAll('[id]');
    nodes.forEach((node) => {
      const m = /^p(\d+)$/.exec(node.id || '');
      if (!m) return;
      const verse = m[1];
      const count = counts[verse];
      if (!count) return;
      if (node.querySelector(':scope > .' + BADGE_CLASS)) return; // already badged
      const badge = document.createElement('button');
      badge.className = BADGE_CLASS;
      badge.type = 'button';
      badge.textContent = String(count);
      badge.title = `${count} talk${count === 1 ? '' : 's'} cite verse ${verse}`;
      badge.setAttribute('data-verse', verse);
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onVerseClick && onVerseClick(verse);
      });
      node.insertBefore(badge, node.firstChild);
      added++;
    });
    return added;
  }

  // Refresh badges for the current chapter. Re-runs a couple of times because the
  // SPA may re-render verses shortly after navigation, dropping our injections.
  async function update(slug, chapter, onVerseClick) {
    clear();
    const counts = await citData().chapterCounts(slug, chapter);
    if (!counts || !Object.keys(counts).length) return;
    let tries = 0;
    const run = () => {
      const added = inject(counts, onVerseClick);
      tries++;
      if (added === 0 && tries < 5) retryTimer = setTimeout(run, 400);
    };
    run();
  }

  root.__BTX = Object.assign(root.__BTX || {}, { verseBadges: { update, clear } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
