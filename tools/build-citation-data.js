#!/usr/bin/env node
/*
 * Build the bundled Scripture Citation Index data for the extension.
 *
 * Reads the BYU "Scripture Citation Index" app SQLite databases and emits a
 * compact, web-fetchable dataset under src/citations/data/. Only Bible (OT/NT)
 * citations are emitted, since the extension activates on Bible chapters.
 *
 * The two app DBs are not shipped; place them in ./source-data/ (gitignored) —
 * which is the default location below. They also live in git/LFS history at the
 * commit that added them.
 *
 * Run (Node 22+, built-in SQLite + zlib — no npm install):
 *   node --experimental-sqlite tools/build-citation-data.js
 *   (defaults: --core ./source-data/core.53.db --content ./source-data/content.53.db --out ./src/citations/data)
 *
 * Inspect the raw DBs first (recommended before a full build) to confirm the
 * real talk.URL formats and talk HTML markup:
 *   node --experimental-sqlite tools/build-citation-data.js --inspect
 *
 * Output layout:
 *   data/index.json            { builtAt, dbUpdated, books:[{slug,fullName,bookId,citations}], counts }
 *   data/sources.json          { [talkId]: { c, sp, ti, d, lbl, url? } }   // one entry per cited talk
 *   data/citations/{slug}.json { cites:{ [citId]:{t,v,sn} }, index:{ [chap]:{ [verse]:[citId,...] } } }
 *   data/talks/{talkId}.html.gz  gzipped cleaned HTML for corpus E/J/T only (G is fetched live)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const BOOKS = require('../src/shared/books.js'); // { LDS_TO_USFM, LDS_TO_BIBLEAPI, ... }

// ---- args ----
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const CORE = arg('--core', path.resolve(__dirname, '..', 'source-data', 'core.53.db'));
const CONTENT = arg('--content', path.resolve(__dirname, '..', 'source-data', 'content.53.db'));
const OUT = arg('--out', path.resolve(__dirname, '..', 'src', 'citations', 'data'));
const INSPECT = process.argv.includes('--inspect');

// Volumes: 1=OT, 2=NT, 3=Book of Mormon, 4=D&C, 5=Pearl of Great Price.
const ALL_VOLUMES = new Set([1, 2, 3, 4, 5]);

// ---- helpers ----
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', ntilde: 'ñ', uacute: 'ú', iacute: 'í', oacute: 'ó', aacute: 'á', agrave: 'à', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…' };
function decodeEntities(s) {
  if (!s) return '';
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, code.toLowerCase()) ? ENTITIES[code.toLowerCase()] : m;
  });
}
function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function decompressTalk(buf) {
  // First 2 bytes are a custom header; standard zlib stream starts at byte 2.
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return zlib.inflateSync(bytes.subarray(2)).toString('utf8');
}
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj)); }

// ---- DB ----
function openDb(file) {
  if (!fs.existsSync(file)) {
    console.error(`ERROR: database not found: ${file}`);
    console.error('Deliver core_53.db / content_53.db to this session, then pass --core/--content.');
    process.exit(2);
  }
  return new DatabaseSync(file, { readOnly: true });
}

// DB Abbr -> our slug for cases the normalization can't reach. D&C sections are
// stored with Abbr "sec" but the Church URL slug (and our map key) is "dc".
const ABBR_ALIAS = { sec: 'dc' };

// Build LDS slug -> book.ID for all standard works, matching on Abbr (normalized
// spaces→hyphens, e.g. '1 ne' → '1-ne') with an alias table and FullName fallback.
// Reuses the Bible + non-Bible name maps from books.js. 0-chapter front matter
// (title page, intros, witnesses, facsimiles) has no slug, so it is skipped.
function buildBookMap(core) {
  const mySlugs = new Set([
    ...Object.keys(BOOKS.LDS_TO_USFM),
    ...Object.keys(BOOKS.NON_BIBLE_NAMES),
  ]);
  const nameToSlug = {};
  for (const [slug, full] of Object.entries(BOOKS.LDS_TO_BIBLEAPI)) nameToSlug[full.toLowerCase()] = slug;

  const rows = core.prepare('SELECT ID, Abbr, FullName, ParentBookID FROM book').all();
  const map = {}; // slug -> { bookId, fullName }
  const unmatched = [];
  for (const r of rows) {
    if (!ALL_VOLUMES.has(r.ParentBookID)) continue;
    const norm0 = String(r.Abbr || '').toLowerCase().trim().replace(/\s+/g, '-');
    const norm = ABBR_ALIAS[norm0] || norm0;
    const slug = mySlugs.has(r.Abbr) ? r.Abbr
      : mySlugs.has(norm) ? norm
      : nameToSlug[String(r.FullName || '').toLowerCase().trim()] || null;
    if (slug) map[slug] = { bookId: r.ID, fullName: BOOKS.bookFullName(slug) || r.FullName };
    else unmatched.push(`${r.ID}:${r.FullName} (Abbr=${r.Abbr})`);
  }
  if (unmatched.length) {
    // Most unmatched rows are intentionally-skipped front matter; log for review.
    console.warn(`Note: ${unmatched.length} book rows had no slug (front matter is expected):\n  ` + unmatched.join('\n  '));
  }
  return map;
}

// ---- corpus-specific bits (validate against --inspect output) ----

// Transform the stored talk.URL into a same-origin churchofjesuschrist.org study
// URL. Modern GC already stores the full church URL; older GC stores lds.org
// ensign paths. Returns null if not derivable (then the talk is bundled).
function toChurchUrl(url) {
  if (!url) return null;
  let u = String(url).trim();
  if (/churchofjesuschrist\.org\/study\//i.test(u)) {
    return u.replace(/^http:/, 'https:');
  }
  // http(s)://lds.org/{path}  ->  https://www.churchofjesuschrist.org/study/{path}
  const m = /^https?:\/\/(?:www\.)?lds\.org\/(.+)$/i.exec(u);
  if (m) return `https://www.churchofjesuschrist.org/study/${m[1]}`;
  return null;
}

// STPJS (Teachings of the Prophet Joseph Smith) bundles citations in a bottom
// footnote list (<div class="footnote">N. <span class="citation">…refs…</span>),
// while the body carries <span class="footRef">N</span> markers. Given a footnote
// number, return the body sentence that marker annotates (its referenced text)
// rather than the bare scripture-reference line.
function stpjsBodyPassage(html, num) {
  const bodyEnd = html.indexOf('<div class="footnotes"');
  const body = bodyEnd >= 0 ? html.slice(0, bodyEnd) : html;
  const TOKEN = '~~FREF~~';
  let marked = body.replace(new RegExp(`<span class="footRef">\\s*${num}\\s*</span>`), TOKEN);
  // Drop the other in-body footnote markers so their numbers don't pollute the text.
  marked = marked.replace(/<span class="footRef">\s*\d+\s*<\/span>/g, '');
  const text = stripTags(marked);
  const idx = text.indexOf(TOKEN);
  if (idx < 0) return '';
  const start = Math.max(
    text.lastIndexOf('. ', idx), text.lastIndexOf('? ', idx),
    text.lastIndexOf('! ', idx), text.lastIndexOf('] ', idx)
  );
  let end = text.length;
  for (const p of ['. ', '? ', '! ']) { const k = text.indexOf(p, idx); if (k >= 0) end = Math.min(end, k + 1); }
  let sentence = text.slice(start >= 0 ? start + 1 : 0, end).replace(TOKEN, '').replace(/\s+/g, ' ').trim();
  if (sentence.length > 220) sentence = sentence.slice(0, 200).replace(/\s+\S*$/, '') + '…';
  return sentence;
}

// Locate a citation in the talk HTML by its citation.ID (the app marks each as
// <span class="citation" id="{citId}">…</span>), return the enclosing block's
// text as a snippet and, for modern GC, the paragraph anchor (e.g. "p21").
function extractCitation(html, citId) {
  if (!html) return { snippet: '', anchor: '' };
  const marker = `<span class="citation" id="${citId}"`;
  const i = html.indexOf(marker);
  if (i < 0) return { snippet: '', anchor: '' };
  // STPJS: the citation span sits inside a "<div class="footnote">N." list item —
  // prefer the body passage that footnote annotates over the reference line.
  const fnStart = html.lastIndexOf('<div class="footnote">', i);
  if (fnStart >= 0) {
    const numM = /<div class="footnote">\s*(\d+)\./.exec(html.slice(fnStart, fnStart + 60));
    if (numM) {
      const passage = stpjsBodyPassage(html, numM[1]);
      if (passage) return { snippet: passage, anchor: '' };
    }
  }
  // Enclosing block = nearest <p ...> or <div ...> opening before the span.
  const blockStart = Math.max(html.lastIndexOf('<p', i), html.lastIndexOf('<div', i), 0);
  const pEnd = html.indexOf('</p>', i);
  const dEnd = html.indexOf('</div>', i);
  let blockEnd = Math.min(pEnd < 0 ? Infinity : pEnd, dEnd < 0 ? Infinity : dEnd);
  if (!isFinite(blockEnd)) blockEnd = Math.min(html.length, i + 500);
  const block = html.slice(blockStart, blockEnd);
  let anchor = '';
  const uriM = /uri="[^"]*?\.(p\d+)"/.exec(block);
  if (uriM) anchor = uriM[1];
  let snippet = stripTags(block);
  if (snippet.length > 220) snippet = snippet.slice(0, 200).replace(/\s+\S*$/, '') + '…';
  return { snippet, anchor };
}

// Human label for a citation's source.
function sourceLabel(core, talk, cit) {
  if (talk.Corpus === 'G' || talk.Corpus === 'E') {
    const d = talk.Date || '';
    const y = d.slice(0, 4);
    const mo = d.slice(5, 7);
    const season = mo === '04' ? 'April' : mo === '10' ? 'October' : (mo ? mo : '');
    return `${season} ${y} General Conference`.trim();
  }
  if (talk.Corpus === 'J') {
    const vol = cit.Volume || '';
    const pg = cit.Page || '';
    return `Journal of Discourses${vol ? ' ' + vol : ''}${pg ? ':' + pg : ''}`;
  }
  if (talk.Corpus === 'T') {
    return `Teachings of the Prophet Joseph Smith${cit.Page ? ', p. ' + cit.Page : ''}`;
  }
  return '';
}

// ---- inspect ----
function inspect(core, content) {
  console.log('=== core tables ===');
  for (const t of core.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
    let n = '?';
    try { n = core.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c; } catch (e) {}
    console.log(`  ${t.name}: ${n}`);
  }
  console.log('\n=== OT/NT books (volumes 1,2) — sample ===');
  for (const r of core.prepare('SELECT ID,Abbr,FullName,ParentBookID,NumChapters FROM book WHERE ParentBookID IN (1,2) ORDER BY ID').all().slice(0, 8)) {
    console.log(`  ${r.ID} ${r.Abbr} | ${r.FullName} | vol=${r.ParentBookID} chs=${r.NumChapters}`);
  }
  console.log('\n=== talk.URL samples per corpus ===');
  for (const corpus of ['E', 'G', 'J', 'T']) {
    const rows = core.prepare('SELECT ID,Corpus,Title,Date,URL FROM talk WHERE Corpus=? LIMIT 3').all(corpus);
    for (const r of rows) console.log(`  [${corpus}] id=${r.ID} date=${r.Date} url=${r.URL}\n        title=${r.Title}`);
    const g = rows[0];
    if (corpus === 'G' && g) console.log(`        -> church url: ${toChurchUrl(g.URL)}`);
  }
  console.log('\n=== sample talk HTML (first ~1200 chars) per corpus ===');
  for (const corpus of ['E', 'G', 'J', 'T']) {
    const row = core.prepare('SELECT ID FROM talk WHERE Corpus=? LIMIT 1').get(corpus);
    if (!row) continue;
    const body = content.prepare('SELECT Text FROM talkbody WHERE TalkID=?').get(row.ID);
    if (!body) { console.log(`  [${corpus}] talk ${row.ID}: no body`); continue; }
    let html;
    try { html = decompressTalk(body.Text); } catch (e) { console.log(`  [${corpus}] decompress failed: ${e.message}`); continue; }
    console.log(`\n  --- [${corpus}] talk ${row.ID} (${html.length} chars) ---`);
    console.log(html.slice(0, 1200).replace(/\n/g, '\n  '));
  }
}

// ---- build ----
function build(core, content) {
  mkdirp(OUT);
  mkdirp(path.join(OUT, 'citations'));
  mkdirp(path.join(OUT, 'talks'));

  const bookMap = buildBookMap(core);
  const slugs = Object.keys(bookMap);
  console.log(`Mapped ${slugs.length} standard-works books.`);

  const sources = {};        // talkId -> meta
  const talkHtmlCache = {};   // talkId -> decompressed html (for snippets/bundling)
  const bundledTalks = new Set();
  let totalCitations = 0;
  const bookCounts = [];

  const getTalkHtml = (talkId) => {
    if (talkId in talkHtmlCache) return talkHtmlCache[talkId];
    const row = content.prepare('SELECT Text FROM talkbody WHERE TalkID=?').get(talkId);
    let html = null;
    if (row && row.Text) { try { html = decompressTalk(row.Text); } catch (e) { html = null; } }
    talkHtmlCache[talkId] = html;
    return html;
  };

  const rowStmt = core.prepare(`
    SELECT cv.Verse AS verse, c.ID AS citId, c.Chapter AS chapter, c.Verses AS verses,
           c.Page AS page, c.Volume AS volume,
           t.ID AS talkId, t.Corpus AS corpus, t.Title AS title, t.Date AS date, t.URL AS url,
           s.GivenNames AS given, s.LastNames AS last
    FROM citation_verse cv
    JOIN citation c ON cv.CitationID = c.ID
    JOIN talk t ON c.TalkID = t.ID
    LEFT JOIN speaker s ON t.SpeakerID = s.ID
    WHERE c.BookID = ?
    ORDER BY c.Chapter, cv.Verse, t.Date DESC
  `);

  for (const slug of slugs) {
    const book = bookMap[slug];
    const rows = rowStmt.all(book.bookId);
    const cites = {};            // citId -> { t, v, sn }
    const index = {};            // chapter -> verse -> [citId]
    let count = 0;

    for (const r of rows) {
      const ch = String(r.chapter);
      const vs = String(r.verse);
      (index[ch] = index[ch] || {});
      (index[ch][vs] = index[ch][vs] || []);
      if (!index[ch][vs].includes(r.citId)) index[ch][vs].push(r.citId);

      if (!(r.citId in cites)) {
        const html = getTalkHtml(r.talkId);
        const { snippet, anchor } = extractCitation(html, r.citId);
        const entry = { t: r.talkId, v: r.verses || vs, sn: snippet };
        if (anchor) entry.a = anchor; // GC paragraph anchor for live deep-link
        cites[r.citId] = entry;
        count++;
      }

      if (!(r.talkId in sources)) {
        const churchUrl = r.corpus === 'G' ? toChurchUrl(r.url) : null;
        sources[r.talkId] = {
          c: r.corpus,
          sp: decodeEntities([r.given, r.last].filter(Boolean).join(' ')) || 'Unknown',
          ti: decodeEntities(r.title || ''),
          d: (r.date || '').slice(0, 7),
          lbl: sourceLabel(core, { Corpus: r.corpus, Date: r.date }, { Page: r.page, Volume: r.volume }),
        };
        if (churchUrl) sources[r.talkId].url = churchUrl; // live-fetch target
      }

      // Bundle full text for everything not opened live: E/J/T always, plus any
      // G talk whose church URL couldn't be derived (so it's still openable).
      const liveG = r.corpus === 'G' && sources[r.talkId] && sources[r.talkId].url;
      if (!liveG && !bundledTalks.has(r.talkId)) {
        const html = getTalkHtml(r.talkId);
        if (html) {
          fs.writeFileSync(path.join(OUT, 'talks', `${r.talkId}.html.gz`), zlib.gzipSync(Buffer.from(html, 'utf8')));
          bundledTalks.add(r.talkId);
        }
      }
    }

    writeJSON(path.join(OUT, 'citations', `${slug}.json`), { book: slug, fullName: book.fullName, cites, index });
    totalCitations += count;
    bookCounts.push({ slug, fullName: book.fullName, bookId: book.bookId, citations: count });
    // free per-book html cache to bound memory
    for (const k of Object.keys(talkHtmlCache)) delete talkHtmlCache[k];
  }

  writeJSON(path.join(OUT, 'sources.json'), sources);
  let dbUpdated = '';
  try { dbUpdated = String(core.prepare('SELECT * FROM updated LIMIT 1').get() && Object.values(core.prepare('SELECT * FROM updated LIMIT 1').get())[0] || ''); } catch (e) {}
  writeJSON(path.join(OUT, 'index.json'), {
    builtAt: new Date().toISOString(),
    dbUpdated,
    books: bookCounts,
    counts: { books: slugs.length, citations: totalCitations, sources: Object.keys(sources).length, bundledTalks: bundledTalks.size },
  });

  console.log(`\nDone. ${totalCitations} citations across ${slugs.length} books; ${Object.keys(sources).length} sources; ${bundledTalks.size} bundled talks.`);
  console.log(`Output: ${OUT}`);
}

// Reused by tools/rederive-js-snippets.js (which has no DBs but the shipped talk HTML).
module.exports = { extractCitation, stpjsBodyPassage, decompressTalk, stripTags, toChurchUrl };

// ---- main ----
if (require.main === module) {
  const core = openDb(CORE);
  const content = openDb(CONTENT);
  if (INSPECT) inspect(core, content);
  else build(core, content);
  core.close();
  content.close();
}
