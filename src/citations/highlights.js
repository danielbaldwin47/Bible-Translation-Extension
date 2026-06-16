/*
 * Local highlights for the inline talk reader. Lets the user select text in a
 * fetched (live GC) or bundled (JoD/early-GC/Joseph Smith) source and mark it.
 * Highlights are saved in chrome.storage.local on this machine (NOT synced to a
 * Church account — that isn't possible) and re-applied when the talk is reopened.
 *
 * Anchoring: each record stores the top-level block's id (the sanitizer keeps
 * ids) and its index, char offsets within that block's textContent, and the
 * quoted text for verification. Re-apply finds the block (id, else index),
 * verifies the text still matches, then re-wraps the offsets in <span.btx-hl>.
 *
 * IIFE -> __BTX.highlights.
 */
(function (root) {
  'use strict';

  const KEY = (talkId) => `btxHl::${talkId}`;

  let menuEl = null;        // shared floating action button
  let activeContainer = null;
  let activeTalkId = null;
  let docBound = false;

  // ---- storage ----
  function load(talkId) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(KEY(talkId), (d) => resolve((d && d[KEY(talkId)]) || [])); }
      catch (e) { resolve([]); }
    });
  }
  function store(talkId, list) {
    try { chrome.storage.local.set({ [KEY(talkId)]: list }); } catch (e) { /* ignore */ }
  }

  // All saved highlights across talks (for a future review menu).
  function all() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(null, (d) => {
          const out = [];
          for (const k of Object.keys(d || {})) {
            if (k.indexOf('btxHl::') === 0) out.push({ talkId: k.slice(7), items: d[k] || [] });
          }
          resolve(out);
        });
      } catch (e) { resolve([]); }
    });
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---- offset helpers ----
  // Top-level block (direct child of container) that owns `node`, or null.
  function blockOf(container, node) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    while (n && n.parentNode !== container) n = n.parentNode;
    return n && n.parentNode === container ? n : null;
  }

  // Character offset of (node, offset) from the start of `block` (text-only).
  function charOffset(block, node, offset) {
    const r = document.createRange();
    r.setStart(block, 0);
    try { r.setEnd(node, offset); } catch (e) { return 0; }
    return r.toString().length;
  }

  // Wrap [start,end) of `block`'s text in a highlight span tagged with hlId.
  function wrapRange(block, start, end, hlId) {
    if (end <= start) return;
    const nodes = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    let pos = 0;
    for (const tn of nodes) {
      const len = tn.nodeValue.length;
      const ns = pos, ne = pos + len;
      pos = ne;
      const os = Math.max(start, ns);
      const oe = Math.min(end, ne);
      if (oe <= os) continue;
      let target = tn;
      const localStart = os - ns;
      const localLen = oe - os;
      if (localStart > 0) target = target.splitText(localStart);
      if (localLen < target.nodeValue.length) target.splitText(localLen);
      const span = document.createElement('span');
      span.className = 'btx-hl';
      span.setAttribute('data-hl-id', hlId);
      target.parentNode.insertBefore(span, target);
      span.appendChild(target);
    }
  }

  function blockText(block) { return (block && block.textContent) || ''; }

  // Re-apply one stored record into the active container.
  function applyRecord(container, rec) {
    let block = null;
    if (rec.blockId) block = container.querySelector(`[id="${String(rec.blockId).replace(/["\\]/g, '\\$&')}"]`);
    if (!block && rec.blockIdx != null) block = container.children[rec.blockIdx] || null;
    if (!block) return;
    if (blockText(block).slice(rec.start, rec.end) !== rec.text) {
      // content shifted; try the index fallback before giving up
      const alt = rec.blockIdx != null ? container.children[rec.blockIdx] : null;
      if (alt && blockText(alt).slice(rec.start, rec.end) === rec.text) block = alt;
      else return;
    }
    wrapRange(block, rec.start, rec.end, rec.id);
  }

  // ---- floating menu ----
  function ensureMenu() {
    if (menuEl) return menuEl;
    const r = (root.__BTX.panel && root.__BTX.panel.getRootEl && root.__BTX.panel.getRootEl()) || document.body;
    menuEl = document.createElement('div');
    menuEl.className = 'btx-hl-menu';
    menuEl.style.display = 'none';
    r.appendChild(menuEl);
    return menuEl;
  }

  function hideMenu() { if (menuEl) menuEl.style.display = 'none'; }

  function showMenuAt(rect, label, onClick) {
    const m = ensureMenu();
    m.textContent = '';
    const btn = document.createElement('button');
    btn.className = 'btx-hl-btn';
    btn.textContent = label;
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    m.appendChild(btn);
    m.style.display = 'block';
    const w = m.offsetWidth || 120;
    m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left)) + 'px';
    m.style.top = Math.min(window.innerHeight - 44, rect.bottom + 6) + 'px';
  }

  // ---- create from current selection ----
  async function createFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const container = activeContainer;
    if (!container || !container.contains(range.startContainer) || !container.contains(range.endContainer)) return;

    const id = newId();
    const recs = [];
    const children = Array.from(container.children);
    children.forEach((block, idx) => {
      if (!range.intersectsNode(block)) return;
      let s = 0, e = blockText(block).length;
      if (block.contains(range.startContainer) || block === range.startContainer) s = charOffset(block, range.startContainer, range.startOffset);
      if (block.contains(range.endContainer) || block === range.endContainer) e = charOffset(block, range.endContainer, range.endOffset);
      if (e <= s) return;
      const text = blockText(block).slice(s, e);
      if (!text.trim()) return;
      recs.push({ id, blockId: block.getAttribute('id') || null, blockIdx: idx, start: s, end: e, text, ts: Date.now() });
    });
    if (!recs.length) return;

    const list = await load(activeTalkId);
    for (const rec of recs) { list.push(rec); applyRecord(container, rec); }
    store(activeTalkId, list);
    sel.removeAllRanges();
    hideMenu();
  }

  async function removeHighlight(hlId) {
    const container = activeContainer;
    if (container) {
      container.querySelectorAll(`.btx-hl[data-hl-id="${String(hlId).replace(/["\\]/g, '\\$&')}"]`).forEach((span) => {
        const parent = span.parentNode;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
        parent.normalize();
      });
    }
    const list = (await load(activeTalkId)).filter((r) => r.id !== hlId);
    store(activeTalkId, list);
    hideMenu();
  }

  // ---- event handlers ----
  function onSelectUp() {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { hideMenu(); return; }
      const range = sel.getRangeAt(0);
      if (!activeContainer || !activeContainer.contains(range.commonAncestorContainer)) { hideMenu(); return; }
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { hideMenu(); return; }
      showMenuAt(rect, '✎ Highlight', createFromSelection);
    }, 0);
  }

  function onContainerClick(e) {
    const span = e.target && e.target.closest && e.target.closest('.btx-hl');
    if (!span) return;
    e.stopPropagation();
    const hlId = span.getAttribute('data-hl-id');
    showMenuAt(span.getBoundingClientRect(), '✕ Remove highlight', () => removeHighlight(hlId));
  }

  function onDocDown(e) {
    if (menuEl && menuEl.style.display !== 'none' && !menuEl.contains(e.target)) hideMenu();
  }

  // Public: attach to a freshly-rendered talk article. Loads + re-applies saved
  // highlights and wires select-to-highlight / click-to-remove.
  async function attach(container, talkId) {
    activeContainer = container;
    activeTalkId = talkId;
    hideMenu();
    container.addEventListener('mouseup', onSelectUp);
    container.addEventListener('click', onContainerClick);
    if (!docBound) { document.addEventListener('mousedown', onDocDown, true); docBound = true; }

    const list = await load(talkId);
    for (const rec of list) { try { applyRecord(container, rec); } catch (e) { /* skip bad record */ } }
  }

  root.__BTX = Object.assign(root.__BTX || {}, { highlights: { attach, all, load } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
