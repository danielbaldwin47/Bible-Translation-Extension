/*
 * Talk source: the one place that knows how a talk is obtained and where its
 * cite sits inside it. Answers a single question for the reader —
 *
 *     load({ entry, source }) -> { html, url, live, findTarget(container) }
 *
 * "give me displayable HTML for this cite, plus how to find its target once
 * that HTML is rendered". Corpus differences (live fetch vs bundled gzip,
 * paragraph anchor vs citation span vs STPJS body passage) are decided by the
 * CORPUS_PLANS table below; talk-view renders and scrolls, and no longer
 * decides anything per corpus.
 *
 * The DOM-free half (corpusPlan + the pre-2013 URL repair) is exported for Node
 * so tools/test-talk-source.js can cover it: run `node --test tools/test-talk-source.js`.
 *
 * IIFE -> __BTX.talkSource (+ module.exports for the Node tests).
 */
(function (root) {
  'use strict';

  const citData = () => root.__BTX && root.__BTX.citData;

  // Per-corpus policy (CONTEXT.md "Corpus"):
  //   fetch  'live'    — same-origin fetch from churchofjesuschrist.org
  //          'bundled' — the shipped talks/{talkId}.html.gz
  //   target 'anchor'       — the talk's paragraph anchor (pN), citation span as fallback
  //          'citationSpan' — <span class="citation" id="{citId}"> in the bundled markup
  //          'bodyPassage'  — STPJS: the body text the footnote annotates, not the
  //                           footnote-list line the citation span actually lives in
  const CORPUS_PLANS = {
    G: { fetch: 'live', target: 'anchor' },          // modern General Conference, 1971–
    E: { fetch: 'bundled', target: 'citationSpan' }, // early General Conference, 1942–70
    J: { fetch: 'bundled', target: 'citationSpan' }, // Journal of Discourses
    T: { fetch: 'bundled', target: 'bodyPassage' },  // Teachings of the Prophet Joseph Smith
  };

  // Resolve the plan for a talk. `hasUrl` is the escape hatch for data that
  // doesn't match the table: an unknown corpus is treated as live iff it ships a
  // URL, and a nominally live talk without one has to read the bundle.
  function corpusPlan(corpus, opts) {
    const hasUrl = opts && 'hasUrl' in opts ? !!opts.hasUrl : true;
    const plan = CORPUS_PLANS[corpus] ||
      (hasUrl ? { fetch: 'live', target: 'anchor' } : { fetch: 'bundled', target: 'citationSpan' });
    if (plan.fetch === 'live' && !hasUrl) return { fetch: 'bundled', target: 'citationSpan' };
    return { fetch: plan.fetch, target: plan.target };
  }

  /* ---------------------------------------------------------------- fetching */

  // Pre-Oct-2013 GC talks were stored without their session segment, e.g.
  // /study/ensign/2012/11/temple-standard. The site now 302s those to the
  // conference landing page (/study/ensign/2012/11), so a plain fetch silently
  // renders the wrong page. resolvedUrlCache memoizes the recovered session-
  // qualified URL per original so we only resolve once per session.
  const resolvedUrlCache = new Map();

  function lastSlug(pathname) {
    return String(pathname).replace(/\/+$/, '').split('/').pop() || '';
  }

  // True when a fetch of `originalUrl` landed somewhere else — i.e. the
  // session-less pre-2013 URL was redirected to the conference landing page.
  function bouncedToConference(originalUrl, landedUrl) {
    return lastSlug(new URL(landedUrl).pathname) !== lastSlug(new URL(originalUrl).pathname);
  }

  // Given the links on that landing page, find the session-qualified URL for our
  // talk: same origin, same conference directory, exactly [session, slug] below
  // it. Returns null (never a guess) when nothing matches. Pure — no DOM, no
  // network — so the repair is testable in Node.
  function pickSessionUrl({ originalUrl, landedUrl, hrefs, origin }) {
    const orig = new URL(originalUrl);
    const base = landedUrl || originalUrl;
    const wanted = origin || new URL(base).origin;
    const slug = lastSlug(orig.pathname);
    const dir = orig.pathname.replace(/\/[^/]+\/?$/, ''); // /study/ensign/2012/11
    for (const href of hrefs || []) {
      let p;
      try { p = new URL(href, base); } catch (e) { continue; }
      if (p.origin !== wanted) continue;
      const path = p.pathname.replace(/\/+$/, '');
      if (!path.startsWith(dir + '/') || path === dir + '/' + slug) continue; // skip the self-link
      const rest = path.slice(dir.length + 1).split('/'); // [session, slug]
      if (rest.length === 2 && rest[1] === slug) {
        const u = new URL(path, wanted);
        u.search = orig.search; // preserve ?lang=eng
        return u.href;
      }
    }
    return null;
  }

  // Deep-link to a live church talk paragraph: "...&id=pN#pN" scrolls to and
  // highlights that paragraph on churchofjesuschrist.org.
  function fullTalkUrl(url, anchor) {
    if (!anchor) return url;
    const base = String(url).split('#')[0];
    const sep = base.indexOf('?') >= 0 ? '&' : '?';
    return `${base}${sep}id=${anchor}#${anchor}`;
  }

  function hrefsIn(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    for (const a of doc.querySelectorAll('a[href]')) out.push(new URL(a.getAttribute('href'), baseUrl).href);
    return out;
  }

  // Fetch a live church talk, recovering from the pre-2013 session-less redirect.
  // Returns { html, url }: html is the talk's HTML (null if it couldn't be loaded),
  // url is the effective talk URL (resolved when a redirect was repaired). Never throws.
  async function fetchLiveTalk(originalUrl) {
    const target = resolvedUrlCache.get(originalUrl) || originalUrl;
    let res;
    try { res = await fetch(target, { credentials: 'omit' }); }
    catch (e) { return { html: null, url: originalUrl }; }
    if (!res.ok) return { html: null, url: res.url };

    // Common case (post-2013, or an already-resolved cache hit): not bounced.
    if (resolvedUrlCache.has(originalUrl) || !bouncedToConference(originalUrl, res.url)) {
      return { html: await res.text(), url: res.url };
    }

    // Bounced to the conference landing page: recover from its table of contents.
    let realUrl = null;
    try {
      realUrl = pickSessionUrl({
        originalUrl,
        landedUrl: res.url,
        hrefs: hrefsIn(await res.text(), res.url),
        origin: location.origin,
      });
    } catch (e) { /* fall through */ }
    if (!realUrl) return { html: null, url: res.url }; // couldn't resolve -> bundled/CTA fallback

    let res2;
    try { res2 = await fetch(realUrl, { credentials: 'omit' }); }
    catch (e) { return { html: null, url: realUrl }; }
    if (!res2.ok) return { html: null, url: res2.url };
    resolvedUrlCache.set(originalUrl, realUrl);
    return { html: await res2.text(), url: res2.url };
  }

  /* ------------------------------------------------------------ scroll target */

  function cssId(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  function byId(container, id) { return container.querySelector(`[id="${cssId(id)}"]`); }

  // STPJS: a citId span lives in the bottom footnote list; map it to the body
  // passage that footnote annotates (the paragraph holding the matching footRef).
  // This is the render-time half of the body-passage rule the build tool also
  // applies to snippets — see docs/adr/0006-stpjs-body-passage-stated-twice.md.
  function bodyPassageForFootnote(container, note) {
    // talk-view's render turns the leading "N." into <span class="btx-footnum">N</span>;
    // fall back to the raw leading number for un-styled markup.
    const sup = note.querySelector('.btx-footnum');
    const num = sup ? sup.textContent.trim() : (/^\s*(\d+)\./.exec(note.textContent) || [])[1];
    if (!num) return null;
    for (const ref of container.querySelectorAll('.btxk-footRef')) {
      if (ref.textContent.trim() === num) return ref.closest('p, .btxk-std') || ref;
    }
    return null;
  }

  // Locate the cite inside the rendered (sanitized) talk, per the corpus plan.
  // Class names are the sanitizer's namespaced ones (btxk-*, see talk-view).
  function findTarget(container, { plan, entry, live }) {
    if (plan.target === 'anchor' && live && entry.anchor) {
      const hit = byId(container, entry.anchor);
      if (hit) return hit;
    }
    if (entry.citId == null) return null;
    const span = byId(container, String(entry.citId)); // <span class="citation" id="{citId}">
    if (!span) return null;
    if (plan.target !== 'bodyPassage') return span;
    const note = span.closest('.btxk-footnote');
    return (note && bodyPassageForFootnote(container, note)) || span;
  }

  /* -------------------------------------------------------------------- load */

  // Public: obtain displayable HTML for `entry` plus how to find its target.
  // Returns { html, url, live, findTarget(container) }; html is null when the
  // talk could not be loaded (caller shows the "open on the site" fallback).
  async function load({ entry, source }) {
    const src = source || {};
    const plan = corpusPlan(src.c, { hasUrl: !!src.url });
    let html = null;
    let url = src.url || null;
    let live = false;

    if (plan.fetch === 'live') {
      const r = await fetchLiveTalk(src.url);
      if (r.html != null) { html = r.html; live = true; }
      url = r.url || src.url;
    }
    if (html == null) { // bundled talk (E/J/T), or a live one whose fetch failed
      try { html = await citData().loadTalkHtml(entry.talkId); }
      catch (e) { html = null; }
    }

    return {
      html,
      url,
      live,
      findTarget: (container) => findTarget(container, { plan, entry, live }),
    };
  }

  const API = { load, corpusPlan, fullTalkUrl, pickSessionUrl, bouncedToConference, lastSlug };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.__BTX = Object.assign(root.__BTX || {}, { talkSource: API });
})(typeof globalThis !== 'undefined' ? globalThis : this);
