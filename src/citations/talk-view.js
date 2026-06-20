/*
 * Inline talk reader. Opens a cited source inside the panel without leaving the
 * page: modern General Conference is fetched live from churchofjesuschrist.org
 * (same-origin), everything else from the bundled gzipped HTML. The fetched HTML
 * is sanitized (allowlist, no scripts/handlers) and we scroll to the citation.
 *
 * IIFE -> __BTX.talkView.
 */
(function (root) {
  'use strict';

  const citData = () => root.__BTX.citData;
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

  // STPJS: a citId span lives in the bottom footnote list; map it to the body
  // passage that footnote annotates (the paragraph holding the matching footRef).
  function bodyPassageForFootnote(container, note) {
    const sup = note.querySelector('.btx-footnum');
    const tn = sup ? null : firstTextNode(note);
    const num = sup ? sup.textContent.trim() : (tn && (/^\s*(\d+)\./.exec(tn.nodeValue) || [])[1]);
    if (!num) return null;
    for (const ref of container.querySelectorAll('.btxk-footRef')) {
      if (ref.textContent.trim() === num) return ref.closest('p, .btxk-std') || ref;
    }
    return null;
  }

  function scrollToCitation(container, scrollEl, { citId, anchor }) {
    let target = null;
    if (anchor) target = container.querySelector(`[id="${cssId(anchor)}"]`);
    if (!target && citId != null) {
      // bundled SCI markup: <span class="btxk-citation" id="{citId}">
      target = container.querySelector(`[id="${cssId(String(citId))}"]`);
      // STPJS: that span is in the footnote list — jump to the cited body passage.
      const note = target && target.closest('.btxk-footnote');
      if (note) target = bodyPassageForFootnote(container, note) || target;
    }
    if (!target) return;
    target.classList.add('btx-cit-highlight');
    // Scroll the real overflow container (.btx-body) to the target. offsetTop is
    // relative to the fixed #btx-root, so use a viewport-rect delta instead.
    if (scrollEl) {
      const delta = target.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
      scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + delta - 16);
    } else {
      target.scrollIntoView({ block: 'start' });
    }
  }

  function cssId(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  // Deep-link to a live church talk paragraph: "...&id=pN#pN" scrolls to and
  // highlights that paragraph on churchofjesuschrist.org.
  function fullTalkUrl(url, anchor) {
    if (!anchor) return url;
    const base = String(url).split('#')[0];
    const sep = base.indexOf('?') >= 0 ? '&' : '?';
    return `${base}${sep}id=${anchor}#${anchor}`;
  }

  // Public: render a talk into `bodyEl`.
  // opts: { entry, source, onBack, autoScroll }
  async function open(bodyEl, opts) {
    const { entry, source, onBack } = opts;
    const autoScroll = opts.autoScroll !== false;
    bodyEl.textContent = '';

    const header = el('div', 'btx-talk-header');
    const back = el('button', 'btx-btn btx-talk-back', '‹ Back');
    back.addEventListener('click', () => onBack && onBack());
    header.appendChild(back);
    const meta = el('div', 'btx-talk-meta');
    meta.appendChild(el('div', 'btx-talk-title', source.ti || 'Talk'));
    meta.appendChild(el('div', 'btx-talk-sub', [source.sp, source.lbl].filter(Boolean).join(' · ')));
    header.appendChild(meta);
    // Subtle "open full talk" link, top-right, for live General Conference.
    if (source.url) {
      const a = el('a', 'btx-talk-source', 'Open full talk ↗');
      a.href = autoScroll ? fullTalkUrl(source.url, entry.anchor) : source.url;
      a.target = '_blank'; a.rel = 'noopener';
      a.title = 'Open the full talk on churchofjesuschrist.org';
      header.appendChild(a);
    }
    bodyEl.appendChild(header);

    const body = el('div', 'btx-talk-scroll');
    bodyEl.appendChild(body);
    body.appendChild(el('div', 'btx-state-text', 'Loading…'));

    let html = null;
    let live = false;
    try {
      if (source.url) { // modern GC: live, same-origin
        const res = await fetch(source.url, { credentials: 'omit' });
        if (res.ok) { html = await res.text(); live = true; }
      }
      if (html == null) { // bundled fallback (E/J/T, or G whose live fetch failed)
        html = await citData().loadTalkHtml(entry.talkId);
      }
    } catch (e) { /* fall through to error */ }

    body.textContent = '';
    if (!html) {
      body.appendChild(el('p', 'btx-state-text', 'Could not load this source.'));
      if (source.url) {
        const a = el('a', 'btx-cta', 'Open on churchofjesuschrist.org');
        a.href = source.url; a.target = '_blank'; a.rel = 'noopener';
        body.appendChild(a);
      }
      return;
    }

    const article = render(html);
    body.appendChild(article);
    // Local highlights (saved on this machine, re-applied on reopen).
    try { highlights() && highlights().attach(article, entry.talkId); } catch (e) { /* non-fatal */ }
    // Defer scroll until layout settles (two frames, so re-applied highlights and
    // reflow are accounted for). Scroll the panel body (the overflow container),
    // not the inner .btx-talk-scroll wrapper. Skipped when the user has turned off
    // "open scrolled to the cited snippet".
    if (autoScroll) {
      requestAnimationFrame(() => requestAnimationFrame(() =>
        scrollToCitation(article, bodyEl, { citId: entry.citId, anchor: live ? entry.anchor : null })));
    }
  }

  root.__BTX = Object.assign(root.__BTX || {}, { talkView: { open, render } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
