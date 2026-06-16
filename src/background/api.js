/*
 * Network layer. All fetches happen here, in the service worker, where
 * host_permissions let us call the APIs without content-script CORS problems.
 *
 * Both providers are normalized to one simple, safe intermediate representation
 * (IR) that the content script renders with text nodes only (no innerHTML):
 *
 *   blocks: [
 *     { type: 'heading', text },
 *     { type: 'para', style, runs: [ {t:'v', n:'3'} | {t:'txt', s:'...', wj:bool} ] }
 *   ]
 *
 * Loaded via importScripts -> self.__BTX.api.
 */
(function (root) {
  'use strict';

  const C = root.__BTX.const;
  const BOOKS = root.__BTX.books;
  const ERR = C.ERR;

  function err(code, message) {
    return { error: { code, message: message || code } };
  }

  // ---- api.bible: list available English bibles for a key ----
  async function listBibles(key) {
    if (!key) return err(ERR.NO_KEY);
    let res;
    try {
      res = await fetch(`${C.API_BIBLE_BASE}/bibles?language=eng`, {
        headers: { 'api-key': key },
      });
    } catch (e) {
      return err(ERR.NETWORK, String(e));
    }
    if (res.status === 401) return err(ERR.INVALID_KEY, 'Invalid API key');
    if (res.status === 403) return err(ERR.FORBIDDEN);
    if (!res.ok) return err(ERR.UNKNOWN, `HTTP ${res.status}`);
    const json = await res.json();
    const bibles = (json.data || []).map((b) => ({
      id: b.id,
      name: b.name,
      abbr: b.abbreviationLocal || b.abbreviation || '',
      copyright: b.copyright || (b.description || ''),
      provider: C.PROVIDER_APIBIBLE,
    }));
    return { bibles };
  }

  // ---- Map HTTP status -> error code ----
  function statusToErr(status) {
    if (status === 401) return ERR.INVALID_KEY;
    if (status === 403) return ERR.FORBIDDEN;
    if (status === 404) return ERR.NOT_FOUND;
    if (status === 429) return ERR.RATE_LIMITED;
    return ERR.UNKNOWN;
  }

  // ---- api.bible chapter fetch + normalize ----
  async function fetchApiBibleChapter(key, bibleId, chapterId) {
    if (!key) return err(ERR.NO_KEY);
    const params = new URLSearchParams({
      'content-type': 'json',
      'include-verse-numbers': 'true',
      'include-notes': 'false',
      'include-titles': 'true',
      'include-chapter-numbers': 'false',
      'include-verse-spans': 'false',
    });
    const url = `${C.API_BIBLE_BASE}/bibles/${encodeURIComponent(bibleId)}/chapters/${encodeURIComponent(chapterId)}?${params}`;
    let res;
    try {
      res = await fetch(url, { headers: { 'api-key': key } });
    } catch (e) {
      return err(ERR.NETWORK, String(e));
    }
    if (!res.ok) return err(statusToErr(res.status), `HTTP ${res.status}`);
    const json = await res.json();
    const data = json.data || {};
    const meta = json.meta || {};
    return {
      payload: {
        blocks: normalizeApiBibleContent(data.content),
        copyright: data.copyright || '',
        reference: data.reference || '',
      },
      // FUMS usage tracking — only forwarded on fresh fetches (not cache hits),
      // so it reports an actual API access. The content script fires it.
      fums: meta.fumsJsInclude || meta.fumsJs
        ? { include: meta.fumsJsInclude || '', js: meta.fumsJs || '' }
        : null,
    };
  }

  // Walk api.bible JSON content into IR blocks.
  function normalizeApiBibleContent(content) {
    const blocks = [];
    if (!Array.isArray(content)) return blocks;
    for (const node of content) {
      if (!node || node.type !== 'tag' || node.name !== 'para') continue;
      const style = (node.attrs && node.attrs.style) || 'p';
      if (isHeadingStyle(style)) {
        const text = collectText(node).trim();
        if (text) blocks.push({ type: 'heading', text });
        continue;
      }
      const runs = [];
      collectRuns(node.items, runs, false);
      if (runs.length) blocks.push({ type: 'para', style, runs });
    }
    return blocks;
  }

  function isHeadingStyle(style) {
    return /^(s\d?|ms\d?|mt\d?|mr|sr|d)$/.test(style);
  }

  // Recursively flatten inline items into runs (verse markers + text), tracking
  // whether we're inside a "words of Christ" (wj) span.
  function collectRuns(items, runs, wj) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item) continue;
      if (item.type === 'text') {
        if (typeof item.text === 'string' && item.text.length) {
          runs.push({ t: 'txt', s: item.text, wj });
        }
      } else if (item.type === 'tag' && item.name === 'verse') {
        const n = item.attrs && item.attrs.number;
        if (n) runs.push({ t: 'v', n: String(n) });
        collectRuns(item.items, runs, wj);
      } else if (item.type === 'tag') {
        const childWj = wj || (item.attrs && item.attrs.style === 'wj');
        collectRuns(item.items, runs, childWj);
      }
    }
  }

  function collectText(node) {
    let out = '';
    const items = node.items || [];
    for (const item of items) {
      if (!item) continue;
      if (item.type === 'text') out += item.text || '';
      else if (item.type === 'tag') out += collectText(item);
    }
    return out;
  }

  // ---- bible-api.com chapter fetch + normalize (public domain, no key) ----
  async function fetchBibleApiChapter(translationId, ldsBook, chapter) {
    const usfm = BOOKS.ldsToUsfm(ldsBook);
    if (!usfm) return err(ERR.NOT_FOUND, 'Unknown book');
    const url = `${C.BIBLE_API_BASE}/data/${encodeURIComponent(translationId)}/${usfm}/${encodeURIComponent(chapter)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      return err(ERR.NETWORK, String(e));
    }
    if (!res.ok) return err(statusToErr(res.status), `HTTP ${res.status}`);
    const json = await res.json();
    const verses = json.verses || [];
    // bible-api gives no paragraph structure, so render as one continuous para.
    const runs = [];
    for (const v of verses) {
      if (v.verse != null) runs.push({ t: 'v', n: String(v.verse) });
      const text = (v.text || '').replace(/\s+/g, ' ').trim();
      if (text) runs.push({ t: 'txt', s: text + ' ', wj: false });
    }
    const tr = json.translation || {};
    const ref = (verses[0] ? `${BOOKS.ldsToBibleApi(ldsBook)} ${chapter}` : '');
    return {
      payload: {
        blocks: runs.length ? [{ type: 'para', style: 'p', runs }] : [],
        copyright: tr.license || tr.name || 'Public domain',
        reference: ref,
      },
    };
  }

  root.__BTX.api = { listBibles, fetchApiBibleChapter, fetchBibleApiChapter };
})(self);
