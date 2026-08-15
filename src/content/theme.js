/*
 * Theme + font mirroring. The site's class names are hashed/unstable, so we never
 * key off them: instead we read RESOLVED computed styles (colors, fonts) from the
 * reading content and copy them into the panel as CSS variables. This makes the
 * panel track light/dark/sepia and the font-size slider automatically.
 *
 * Interface:
 *   mirror(resolveTarget) -> { refresh() }
 *       Style the target element like the site and keep it that way: the initial
 *       apply, the launch-time re-apply until the site's toolbar height resolves,
 *       and the theme/font/resize watching afterwards. `resolveTarget()` is asked
 *       on every apply and may return null when there is nothing mounted to style.
 *       `refresh()` re-applies now and restarts the alignment chain — call it when
 *       a target appears; the policy below decides whether more applies follow.
 *       A mirror lives as long as the content script does; there is no teardown.
 *   resolveReadingContainer() -> element   structural hook, ADR-0005
 *
 * Capturing (including which of the reading column's paragraphs is the one to
 * mirror), applying, observing and the retry policy are all internal: callers
 * say "keep this element looking like the site", not how to get there.
 *
 * IIFE -> __BTX.theme (ADR-0002). The pure policies below (the retry backoff,
 * the dominant-paragraph pick, and which applies are redundant) are also
 * exported for Node (tools/validate-theme-align.js); the DOM half is skipped
 * there.
 */
(function (root) {
  'use strict';

  // ---- Pure retry policy (Node-testable) ---------------------------------
  // The site's sticky toolbar may not be laid out when we first apply, so its
  // height reads as unknown and the two header bars misalign until something
  // (a resize) re-captures it. So we re-apply on a short backoff at launch —
  // this is the whole policy: after the apply for `attempt`, how long until the
  // next one, and when to give up (null). It must terminate: on a page where no
  // plausible toolbar exists the height never resolves.
  const ALIGN_ATTEMPTS = 8;
  const ALIGN_MAX_DELAY = 500;

  function nextAlignDelay(attempt, aligned) {
    if (aligned || attempt >= ALIGN_ATTEMPTS) return null;
    return attempt === 0 ? 0 : Math.min(ALIGN_MAX_DELAY, 50 * 2 ** (attempt - 1));
  }

  // ---- Pure "which paragraph do we mirror?" policy (Node-testable) --------
  // The reading column's paragraphs are not all body text: the chapter heading,
  // the byline and the summary are paragraphs too, and the heading comes first
  // in document order and is set larger. Taking the first one mirrored the
  // heading into the panel (issue #33), so instead: whichever size covers the
  // most text by character count wins. A chapter is overwhelmingly verse text
  // by volume, so this holds whatever the markup shape or document order is,
  // without hard-coding a verse selector (ADR-0005 — and the selector that
  // looked right is exactly what broke).
  //
  // Family and line-height come from the winning size's biggest paragraph, so
  // the three mirrored values describe one real paragraph rather than three.
  // Ties go to document order, so a re-apply on an unchanged page is a no-op.
  const MAX_TEXT_SAMPLES = 40; // bounded: this runs on every re-apply

  function dominantTextStyle(samples) {
    if (!samples || !samples.length) return null;
    const bySize = new Map();
    for (const sample of samples) {
      if (!sample || !sample.size || !(sample.chars > 0)) continue;
      const group = bySize.get(sample.size);
      if (!group) {
        bySize.set(sample.size, { chars: sample.chars, best: sample });
      } else {
        group.chars += sample.chars;
        if (sample.chars > group.best.chars) group.best = sample;
      }
    }
    let winner = null;
    for (const group of bySize.values()) {
      if (!winner || group.chars > winner.chars) winner = group;
    }
    if (!winner) return null;
    return { size: winner.best.size, font: winner.best.font, line: winner.best.line };
  }

  // ---- Pure "is this apply worth doing?" policy (Node-testable) -----------
  // An apply that would change nothing must write nothing: the panel is woken
  // by the reading column's *reflow* (see observe()), and the panel itself
  // reserves page width with a margin on <html>, so wake-ups arrive that carry
  // no new styling. Answering them with a write is how a watcher turns into a
  // loop. Same captured values -> no write -> the wake-up dies here.
  const VAR_KEYS = ['bg', 'fg', 'headerBg', 'headerH', 'font', 'size', 'line', 'dark'];

  function sameVars(a, b) {
    if (!a || !b) return false;
    return VAR_KEYS.every((k) => a[k] === b[k]);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ALIGN_ATTEMPTS,
      ALIGN_MAX_DELAY,
      nextAlignDelay,
      MAX_TEXT_SAMPLES,
      dominantTextStyle,
      VAR_KEYS,
      sameVars,
      lineHeightOf, // hoisted from the DOM half below: pure, and load-bearing
    };
  }
  if (typeof document === 'undefined') return; // Node: pure policy only

  // ---- DOM half ------------------------------------------------------------

  // First element matching any of these selectors, in the order given.
  function firstMatch(candidates) {
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // A computed line-height the panel can use: `normal` is not a number we can
  // hand to CSS custom properties meaningfully, so it becomes our own default.
  // The mirrored line-height, always as an absolute length. Chrome resolves a
  // set line-height to px already; `normal` is the one case that doesn't, and
  // it is stated in px here off the element's own size so the panel never has
  // to ask which kind of value it holds — the panel's text-size multiplier
  // scales it, and scaling a ratio would apply the multiplier twice.
  function lineHeightOf(cs) {
    if (cs.lineHeight && cs.lineHeight !== 'normal') return cs.lineHeight;
    const px = parseFloat(cs.fontSize);
    return Number.isFinite(px) ? `${Math.round(px * 1.6 * 100) / 100}px` : '27.2px';
  }

  // Find the element that holds the scripture text, using stable-ish hooks with
  // graceful fallbacks. Used for the panel's colors, and as the style of last
  // resort when no reading column resolves.
  function resolveReadingContainer() {
    return firstMatch([
      'main [data-aid] p',
      'main article p',
      'main p',
      'article p',
      'main [data-aid]',
      'main',
      'article',
    ]) || document.body;
  }

  // The block that holds the chapter, as opposed to one paragraph of it: the
  // set of paragraphs we sample for the size to mirror, and the element whose
  // reflow tells us the site's font-size setting moved. Same ADR-0005 rules —
  // structural hooks only. Null when there is no plausible reading column, in
  // which case the caller keeps the single-element fallback.
  //
  // Widest first, deliberately — the opposite of resolveReadingContainer, which
  // wants one representative element. The pick below is weighted by how much
  // text each size covers, so a container wider than the chapter is harmless
  // (the chapter still holds most of the text in it) while one narrower than
  // the chapter is fatal: `main [data-aid]` resolves to the *first* such block
  // in document order, which on a /study page wraps the chapter heading. Sample
  // that alone and we are back to mirroring the heading, which is this bug.
  function resolveReadingColumn() {
    return firstMatch(['main', 'article', 'main [data-aid]']);
  }

  // Computed size/family/line-height of the column's paragraphs, with how much
  // text each holds — the input to dominantTextStyle. Bounded by
  // MAX_TEXT_SAMPLES: this runs on every re-apply, including each step of the
  // launch alignment chain. The chapter sits at the top of the column, so the
  // budget is spent on it before it reaches anything below.
  function sampleTextStyles(column) {
    if (!column) return [];
    const out = [];
    const paras = column.querySelectorAll('p');
    for (const el of paras) {
      if (out.length >= MAX_TEXT_SAMPLES) break;
      const chars = (el.textContent || '').trim().length;
      if (!chars) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      out.push({ chars, size: cs.fontSize, font: cs.fontFamily, line: lineHeightOf(cs) });
    }
    return out;
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
    // The text the panel is meant to read like is the body of the chapter, not
    // the first paragraph in the column. Where there is no resolvable column to
    // sample, fall back to the single element's own style, as before.
    const text = dominantTextStyle(sampleTextStyles(resolveReadingColumn())) || {
      font: cs.fontFamily,
      size: cs.fontSize,
      line: lineHeightOf(cs),
    };
    return {
      bg,
      fg,
      headerBg: captureHeaderBg(bg, dark),
      headerH: captureHeaderHeight(),
      font: text.font || 'Georgia, serif',
      size: text.size || '17px',
      line: text.line || '27.2px', // 17px × 1.6, stated as a length like every other line value
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

  // Watch for site theme/font changes; debounced. Lives for the life of the page
  // (the content script has no teardown), so there is nothing to disconnect.
  //
  // Attribute mutations on <html>/<body> catch the theme; they do NOT catch the
  // site's font-size setting, which is applied somewhere deeper — moving that
  // slider used to leave the panel at its old size until a reload (issue #33).
  // Instead we watch the reading column's *size*: any font-size change reflows
  // it, whatever attribute the site actually mutated. Returns { retarget } so
  // the caller can re-point the observer after an SPA navigation swaps the
  // column out.
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

    let watched = null;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    function retarget() {
      if (!ro) return;
      const column = resolveReadingColumn();
      if (column === watched) return;
      if (watched) ro.unobserve(watched);
      watched = column;
      if (column) ro.observe(column); // fires once on observe; the apply is a no-op if nothing moved
    }
    retarget();

    return { retarget };
  }

  // Keep resolveTarget()'s element looking like the site, for as long as it
  // lives: apply now, run the launch-alignment chain while the site toolbar
  // height is still unknown, and re-apply on every theme/font/resize change.
  function mirror(resolveTarget) {
    let alignTimer = null;
    let alignFrame = null;
    let watch = null;
    let lastEl = null;
    let lastVars = null;

    // Apply the site's look to whatever is mounted; false = nothing to style.
    // A capture identical to the last one writes nothing (sameVars, above) —
    // that is what makes the reading-column ResizeObserver safe to answer. A
    // freshly mounted panel always gets written, whatever it was styled with.
    function applyNow() {
      const el = resolveTarget();
      if (!el) return false;
      const vars = capture(); // always: this is what resolves the header height
      if (el !== lastEl || !sameVars(vars, lastVars)) {
        apply(el, vars);
        lastEl = el;
        lastVars = vars;
      }
      if (watch) watch.retarget(); // an SPA nav may have swapped the column out
      return true;
    }

    function cancelAlign() {
      clearTimeout(alignTimer);
      if (alignFrame != null) cancelAnimationFrame(alignFrame);
      alignTimer = null;
      alignFrame = null;
    }

    // One apply, then schedule the next per the retry policy. Applying inside a
    // frame keeps each measurement after the site has had a chance to lay out.
    function alignTick(attempt) {
      alignTimer = null;
      alignFrame = null;
      // Nothing mounted: no apply happened, so the toolbar height can't resolve
      // and retrying is pointless. refresh() restarts the chain once there is a
      // target to align.
      if (!applyNow()) return;
      const delay = nextAlignDelay(attempt, headerHeightPx != null);
      if (delay == null) return;
      alignTimer = setTimeout(() => {
        alignFrame = requestAnimationFrame(() => alignTick(attempt + 1));
      }, delay);
    }

    function refresh() {
      cancelAlign(); // one chain at a time — a fresh refresh restarts the backoff
      alignTick(0);
    }

    watch = observe(applyNow);
    refresh();
    return { refresh };
  }

  root.__BTX = Object.assign(root.__BTX || {}, {
    theme: { resolveReadingContainer, mirror },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
