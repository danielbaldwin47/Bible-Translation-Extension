/*
 * Theme + font mirroring. The site's class names are hashed/unstable, so we never
 * key off them: instead we read RESOLVED computed styles (colors, fonts) from the
 * reading content and copy them into the panel as CSS variables. This makes the
 * panel track light/dark/sepia and the font-size slider automatically.
 *
 * IIFE -> __BTX.theme.
 */
(function (root) {
  'use strict';

  // Find the element that holds the scripture text, using stable-ish hooks with
  // graceful fallbacks. Used to mirror font-size/family/line-height.
  function resolveReadingContainer() {
    const candidates = [
      'main [data-aid] p',
      'main article p',
      'main p',
      'article p',
      'main [data-aid]',
      'main',
      'article',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  }

  // Best-effort: height of the site's sticky top toolbar, so the panel header can
  // line up with it. Cached once found (so it doesn't change as the user scrolls).
  let headerHeightPx = null;
  function captureHeaderHeight() {
    if (headerHeightPx != null) return headerHeightPx;
    let best = 0;
    const cands = document.querySelectorAll('header, [role="banner"], [role="toolbar"], nav');
    for (const el of cands) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.top <= 8 && r.height >= 36 && r.height <= 72) best = best ? Math.min(best, r.height) : r.height;
    }
    if (best) headerHeightPx = Math.round(best);
    return headerHeightPx; // null until a plausible bar is found
  }

  // Walk up from el to find the first non-transparent background color.
  function effectiveBackground(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) return bg;
      node = node.parentElement;
    }
    const docBg = getComputedStyle(document.documentElement).backgroundColor;
    return docBg && !/transparent/.test(docBg) ? docBg : 'rgb(255,255,255)';
  }

  // Lighten (amt > 0) or darken (amt < 0) an rgb string toward white/black.
  function shade(rgb, amt) {
    const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(rgb || '');
    if (!m) return rgb;
    const adj = (v) => Math.max(0, Math.min(255, Math.round(Number(v) + 255 * amt)));
    return `rgb(${adj(m[1])}, ${adj(m[2])}, ${adj(m[3])})`;
  }

  // Color for the panel header bar: match the site's top toolbar when we can read
  // it, otherwise derive a distinct shade from the page background.
  function captureHeaderBg(bg, dark) {
    const hdr = document.querySelector('header');
    if (hdr) {
      const c = getComputedStyle(hdr).backgroundColor;
      if (c && !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(c)) return c;
    }
    return shade(bg, dark ? 0.10 : -0.05);
  }

  function luminance(rgb) {
    const m = /(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/.exec(rgb || '');
    if (!m) return 1;
    const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function capture() {
    const reader = resolveReadingContainer();
    const cs = getComputedStyle(reader);
    const bg = effectiveBackground(reader);
    const fg = cs.color || (luminance(bg) < 0.5 ? 'rgb(230,230,230)' : 'rgb(20,20,20)');
    const dark = luminance(bg) < 0.5;
    return {
      bg,
      fg,
      headerBg: captureHeaderBg(bg, dark),
      headerH: captureHeaderHeight(),
      font: cs.fontFamily || 'Georgia, serif',
      size: cs.fontSize || '17px',
      line: cs.lineHeight && cs.lineHeight !== 'normal' ? cs.lineHeight : '1.6',
      dark,
    };
  }

  function apply(targetEl, vars) {
    if (!targetEl) return;
    const v = vars || capture();
    targetEl.style.setProperty('--btx-bg', v.bg);
    targetEl.style.setProperty('--btx-fg', v.fg);
    if (v.headerBg) targetEl.style.setProperty('--btx-header-bg', v.headerBg);
    if (v.headerH) targetEl.style.setProperty('--btx-header-h', v.headerH + 'px');
    targetEl.style.setProperty('--btx-font', v.font);
    targetEl.style.setProperty('--btx-size', v.size);
    targetEl.style.setProperty('--btx-line', v.line);
    targetEl.setAttribute('data-btx-theme', v.dark ? 'dark' : 'light');
  }

  // Observe site theme/font changes; debounced. Returns a disconnect function.
  function observe(onChange) {
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 120);
    };
    const mo = new MutationObserver(schedule);
    const attrFilter = ['class', 'style', 'data-theme', 'data-scheme', 'data-color-scheme'];
    mo.observe(document.documentElement, { attributes: true, attributeFilter: attrFilter });
    if (document.body) {
      mo.observe(document.body, { attributes: true, attributeFilter: attrFilter });
    }
    window.addEventListener('resize', schedule);
    return () => {
      mo.disconnect();
      window.removeEventListener('resize', schedule);
      clearTimeout(timer);
    };
  }

  root.__BTX = Object.assign(root.__BTX || {}, {
    theme: { resolveReadingContainer, capture, apply, observe, luminance },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
