/*
 * Chapter detection + SPA navigation handling.
 *
 * The site is a React single-page app: chapter changes happen without a full
 * page reload, so we watch for navigation three ways (deduped downstream):
 *   1. an inline page-world script that patches history.pushState/replaceState
 *   2. popstate (back/forward)
 *   3. a low-frequency href poll (CSP-safe fallback; sufficient on its own)
 *
 * IIFE -> __BTX.detect (isolated world; shares the DOM window with the page).
 */
(function (root) {
  'use strict';

  const BOOKS = root.__BTX.books;

  const PATH_RE = /^\/study\/scriptures\/([^/]+)\/([^/]+)\/(\d+)$/;

  // Returns { collection, ldsBook, chapter, lang, isBible } or null if the URL is
  // not a citation-indexed standard-works chapter. isBible gates translation mode;
  // non-Bible books (BoM/D&C/PGP) are citations-only.
  function parseLocation(pathname, search) {
    const m = PATH_RE.exec(pathname || '');
    if (!m) return null;
    const collection = m[1];
    const ldsBook = m[2];
    if (!BOOKS.isKnownBook(collection, ldsBook)) return null; // unknown/non-indexed
    const lang = new URLSearchParams(search || '').get('lang') || 'eng';
    return { collection, ldsBook, chapter: m[3], lang, isBible: BOOKS.isBibleCollection(collection) };
  }

  function toUsfmChapterId(parsed) {
    const usfm = BOOKS.ldsToUsfm(parsed.ldsBook);
    return usfm ? `${usfm}.${parsed.chapter}` : null;
  }

  // Inject a page-world script that re-dispatches history navigations. Loaded as a
  // web-accessible file (allowed by the site CSP, which lists our extension origin)
  // rather than inline (which the CSP blocks).
  function injectHistoryHook() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('src/content/page-hook.js');
      script.onload = function () { script.remove(); };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      // If blocked, the poll below still covers navigation.
    }
  }

  // Calls onNavigate() whenever the location may have changed. Caller dedupes.
  function setupNavigation(onNavigate) {
    injectHistoryHook();
    let last = location.href;
    const fire = () => {
      if (location.href !== last) {
        last = location.href;
      }
      onNavigate();
    };
    window.addEventListener('btx:locationchange', fire);
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        onNavigate();
      }
    }, 750);
  }

  root.__BTX = Object.assign(root.__BTX || {}, {
    detect: { parseLocation, toUsfmChapterId, setupNavigation },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
