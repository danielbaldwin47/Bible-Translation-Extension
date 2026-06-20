/*
 * Citation-index data access (content script). Loads the prebuilt, web-accessible
 * dataset under src/citations/data/ on demand and caches it:
 *   - sources.json        (talk metadata, loaded once)
 *   - citations/{slug}.json (per-book shard: { cites, index })
 *   - talks/{talkId}.html.gz (bundled talk HTML for JoD / early GC / Joseph Smith)
 *
 * Everything is static + same-extension, so no service worker is involved.
 * IIFE -> __BTX.citData.
 */
(function (root) {
  'use strict';

  const base = (p) => chrome.runtime.getURL('src/citations/data/' + p);

  let sourcesPromise = null;
  const shardPromises = {};   // slug -> Promise<shard|null>
  const talkPromises = {};    // talkId -> Promise<string|null>

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function loadSources() {
    if (!sourcesPromise) {
      sourcesPromise = fetchJSON(base('sources.json')).catch((e) => {
        sourcesPromise = null; // allow retry
        throw e;
      });
    }
    return sourcesPromise;
  }

  // Returns the per-book shard, or null if the book has no data file.
  function loadShard(slug) {
    if (!(slug in shardPromises)) {
      shardPromises[slug] = fetch(base(`citations/${slug}.json`))
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
    }
    return shardPromises[slug];
  }

  // Bundled talk HTML (gzip). Returns decompressed HTML string, or null.
  function loadTalkHtml(talkId) {
    if (!(talkId in talkPromises)) {
      talkPromises[talkId] = (async () => {
        const res = await fetch(base(`talks/${talkId}.html.gz`));
        if (!res.ok) return null;
        const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).text();
      })().catch(() => null);
    }
    return talkPromises[talkId];
  }

  // Deduped citations for a chapter, plus each citation's in-chapter verse span.
  // A single citation can cover a verse range, so it is indexed under every verse
  // it spans; we collect those verses (versesInChapter) so the panel can show a
  // citation once and label its range instead of repeating it per verse.
  // Returns { verseOrder:[int], byVerse:{ [verse]:[citId] }, entries:{ [citId]:entry },
  //   uniqueTotal } — or null when the book has no data file.
  async function chapterData(slug, chapter) {
    const [shard, sources] = await Promise.all([loadShard(slug), loadSources().catch(() => ({}))]);
    if (!shard) return null;
    const chap = shard.index[String(chapter)];
    if (!chap) return { verseOrder: [], byVerse: {}, entries: {}, uniqueTotal: 0 };

    const verseOrder = Object.keys(chap).map(Number).sort((a, b) => a - b);
    const byVerse = {};
    const spanOf = {}; // citId -> [verse,...] (ascending, since verseOrder is sorted)
    for (const v of verseOrder) {
      const ids = chap[String(v)] || [];
      byVerse[v] = ids;
      for (const id of ids) (spanOf[id] = spanOf[id] || []).push(v);
    }

    const entries = {};
    for (const id of Object.keys(spanOf)) {
      const c = shard.cites[id];
      if (!c) continue; // skip ids with no resolvable citation record
      entries[id] = {
        citId: id,
        talkId: c.t,
        verses: c.v,
        versesInChapter: spanOf[id],
        snippet: c.sn,
        anchor: c.a,
        source: sources[c.t] || {},
      };
    }
    return { verseOrder, byVerse, entries, uniqueTotal: Object.keys(entries).length };
  }

  // Per-verse counts for badges: { [verse]: count }.
  async function chapterCounts(slug, chapter) {
    const shard = await loadShard(slug);
    if (!shard) return {};
    const chap = shard.index[String(chapter)];
    if (!chap) return {};
    const counts = {};
    for (const verse of Object.keys(chap)) counts[verse] = chap[verse].length;
    return counts;
  }

  root.__BTX = Object.assign(root.__BTX || {}, {
    citData: { loadSources, loadShard, loadTalkHtml, chapterData, chapterCounts },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
