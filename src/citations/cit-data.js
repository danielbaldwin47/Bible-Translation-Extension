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

  // Convenience: citations for a given chapter, grouped by verse, resolved with
  // source metadata. Returns { byVerse: { [verse]: [entry] }, total } or null.
  async function chapterCitations(slug, chapter) {
    const [shard, sources] = await Promise.all([loadShard(slug), loadSources().catch(() => ({}))]);
    if (!shard) return null;
    const chap = shard.index[String(chapter)];
    if (!chap) return { byVerse: {}, total: 0 };
    const byVerse = {};
    let total = 0;
    for (const verse of Object.keys(chap)) {
      const entries = [];
      for (const citId of chap[verse]) {
        const c = shard.cites[citId];
        if (!c) continue;
        entries.push({ citId, talkId: c.t, verses: c.v, snippet: c.sn, anchor: c.a, source: sources[c.t] || {} });
        total++;
      }
      byVerse[verse] = entries;
    }
    return { byVerse, total };
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
    citData: { loadSources, loadShard, loadTalkHtml, chapterCitations, chapterCounts },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
