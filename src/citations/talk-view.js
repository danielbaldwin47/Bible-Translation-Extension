/*
 * Inline talk reader. Opens a cited source inside the panel without leaving the
 * page: it asks __BTX.talkSource for the talk's HTML plus a way to locate the
 * cite in it, sanitizes that HTML (allowlist, no scripts/handlers), renders it
 * and scrolls to the target. Where the HTML comes from and where the target sits
 * per corpus is talk-source's business, not this file's.
 *
 * IIFE -> __BTX.talkView.
 */
(function (root) {
  'use strict';

  const talkSource = () => root.__BTX.talkSource;
  const highlights = () => root.__BTX.highlights;

  // Tags kept when sanitizing fetched talk HTML; everything else is unwrapped.
  const ALLOWED = new Set(['P', 'DIV', 'SPAN', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'EM', 'I', 'B', 'STRONG', 'SUP', 'SUB', 'BR', 'UL', 'OL', 'LI', 'SECTION', 'ARTICLE']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'SVG',
    'HEAD', 'NAV', 'HEADER', 'FOOTER', 'BUTTON', 'FORM', 'INPUT', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO']);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Recursively copy `src` children into `dest`, keeping only allowed elements
  // and the `id`/`class` attributes (needed to locate + style the citation).
  function sanitizeInto(src, dest) {
    for (const node of Array.from(src.childNodes)) {
      if (node.nodeType === 3) { // text
        dest.appendChild(document.createTextNode(node.nodeValue));
      } else if (node.nodeType === 1) { // element
        const tag = node.tagName;
        if (DROP.has(tag)) continue;
        if (tag === 'A') { // keep link text, drop the href
          sanitizeInto(node, dest);
          continue;
        }
        if (ALLOWED.has(tag)) {
          const c = document.createElement(tag);
          const id = node.getAttribute('id');
          if (id) c.setAttribute('id', id);
          const cls = node.getAttribute('class');
          if (cls) c.setAttribute('class', 'btxk-' + cls.split(/\s+/).join(' btxk-')); // namespace classes
          sanitizeInto(node, c);
          dest.appendChild(c);
        } else {
          sanitizeInto(node, dest); // unwrap unknown tags, keep their text
        }
      }
    }
  }

  // Pick the most content-ful root from a parsed document.
  function pickContentRoot(doc) {
    const sels = ['.gcbody', '.discourseBody', '.page', 'article', 'main', '#content', 'body'];
    for (const s of sels) {
      const node = doc.querySelector(s);
      if (node && node.textContent && node.textContent.trim().length > 200) return node;
    }
    return doc.body || doc.documentElement;
  }

  function render(rawHtml) {
    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
    const rootNode = pickContentRoot(doc);
    const wrap = el('div', 'btx-talk');
    sanitizeInto(rootNode, wrap);
    styleFootnoteNumbers(wrap);
    return wrap;
  }

  // First non-empty text node within `node`, in document order.
  function firstTextNode(node) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) { if (n.nodeValue && n.nodeValue.trim()) return n; }
    return null;
  }

  // Bundled STPJS footnote list items begin with a literal "N." text node. Replace
  // it with a blue superscript number (no period), matching the in-body footRef
  // markers (styled via .btx-footnum in citations.css).
  function styleFootnoteNumbers(article) {
    for (const note of article.querySelectorAll('.btxk-footnote')) {
      const tn = firstTextNode(note);
      const m = tn && /^(\s*)(\d+)\.(\s*)/.exec(tn.nodeValue);
      if (!m) continue;
      tn.nodeValue = tn.nodeValue.slice(m[0].length);
      note.insertBefore(el('span', 'btx-footnum', m[2]), tn);
    }
  }

  // Scroll `scrollEl` to a target element talk-source located, and mark it.
  function scrollToTarget(target, scrollEl, offset) {
    if (!target) return;
    target.classList.add('btx-cit-highlight');
    // Scroll the real overflow container (.btx-body) to the target. offsetTop is
    // relative to the fixed #btx-root, so use a viewport-rect delta instead.
    if (scrollEl) {
      const delta = target.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
      scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + delta - (offset || 16));
    } else {
      target.scrollIntoView({ block: 'start' });
    }
  }

  // Esc closes the reader (same as "‹ Back"). One document-level handler; rebound
  // to the current reader on each open(), self-removing once its reader is gone.
  let escHandler = null;
  function bindEsc(backBtn) {
    unbindEsc();
    escHandler = (e) => {
      if (e.key !== 'Escape') return;
      if (!document.contains(backBtn)) { unbindEsc(); return; } // reader was replaced
      e.preventDefault();
      backBtn.click();
    };
    document.addEventListener('keydown', escHandler);
  }
  function unbindEsc() {
    if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
  }

  // Public: render a talk into `bodyEl`.
  // opts: { entry, source, onBack, autoScroll }
  async function open(bodyEl, opts) {
    const { entry, source, onBack } = opts;
    const autoScroll = opts.autoScroll !== false;
    bodyEl.textContent = '';

    const header = el('div', 'btx-talk-header');
    const back = el('button', 'btx-btn btx-talk-back', '‹ Back');
    back.addEventListener('click', () => { unbindEsc(); onBack && onBack(); });
    back.title = 'Back to citations (Esc)';
    header.appendChild(back);
    bindEsc(back);
    const meta = el('div', 'btx-talk-meta');
    const titleEl = el('div', 'btx-talk-title', source.ti || 'Talk');
    titleEl.title = source.ti || '';
    meta.appendChild(titleEl);
    // Keep the study context visible: which verse(s) this source cites.
    const citPanel = root.__BTX.citPanel;
    const verses = entry.versesInChapter && entry.versesInChapter.length && citPanel
      ? 'cites ' + citPanel.verseLabel(entry.versesInChapter) : '';
    const subText = [source.sp, source.lbl, verses].filter(Boolean).join(' · ');
    const subEl = el('div', 'btx-talk-sub', subText);
    subEl.title = subText; // header lines are single-line ellipsized
    meta.appendChild(subEl);
    header.appendChild(meta);
    // Subtle "open full talk" link, top-right, for live General Conference.
    let fullTalkLink = null;
    if (source.url) {
      const a = el('a', 'btx-talk-source', 'Open full talk ↗');
      a.href = autoScroll ? talkSource().fullTalkUrl(source.url, entry.anchor) : source.url;
      a.target = '_blank'; a.rel = 'noopener';
      a.title = 'Open the full talk on churchofjesuschrist.org';
      header.appendChild(a);
      fullTalkLink = a;
    }
    bodyEl.appendChild(header);

    const body = el('div', 'btx-talk-scroll');
    bodyEl.appendChild(body);
    body.appendChild(el('div', 'btx-state-text', 'Loading…'));

    // The seam: talk-source decides live-vs-bundled and hands back a locator for
    // this cite's scroll target. Never throws; html is null when nothing loaded.
    let loaded = { html: null, url: source.url || null, findTarget: () => null };
    try { loaded = await talkSource().load({ entry, source }); }
    catch (e) { /* fall through to error */ }

    // Point the header link at the effective URL (the stored one may 302 away).
    if (fullTalkLink && loaded.url) {
      fullTalkLink.href = autoScroll ? talkSource().fullTalkUrl(loaded.url, entry.anchor) : loaded.url;
    }

    body.textContent = '';
    if (!loaded.html) {
      body.appendChild(el('p', 'btx-state-text', 'Could not load this source.'));
      if (source.url) {
        const a = el('a', 'btx-cta', 'Open on churchofjesuschrist.org');
        a.href = loaded.url || source.url; a.target = '_blank'; a.rel = 'noopener';
        body.appendChild(a);
      }
      return;
    }

    const article = render(loaded.html);
    body.appendChild(article);
    // Local highlights (saved on this machine, re-applied on reopen).
    try { highlights() && highlights().attach(article, entry.talkId); } catch (e) { /* non-fatal */ }
    // Defer scroll until layout settles (two frames, so re-applied highlights and
    // reflow are accounted for). Scroll the panel body (the overflow container),
    // not the inner .btx-talk-scroll wrapper. Skipped when the user has turned off
    // "open scrolled to the cited snippet".
    if (autoScroll) {
      // The reader header is sticky, so offset the scroll target below it.
      requestAnimationFrame(() => requestAnimationFrame(() =>
        scrollToTarget(loaded.findTarget(article), bodyEl, header.offsetHeight + 10)));
    }
  }

  root.__BTX = Object.assign(root.__BTX || {}, { talkView: { open, render } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
