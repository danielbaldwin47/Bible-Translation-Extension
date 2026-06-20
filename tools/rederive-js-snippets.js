#!/usr/bin/env node
/*
 * Recompute the snippet (`sn`) for Teachings of the Prophet Joseph Smith (corpus
 * "T") citations directly from the shipped, gzipped talk HTML — no source DBs
 * needed. The STPJS app marks citations in a bottom footnote list, so the build's
 * original snippet was the bare scripture-reference line ("11. Ex. 6:3 …"); this
 * rewrites it to the body passage that footnote annotates (see extractCitation /
 * stpjsBodyPassage in build-citation-data.js, which this reuses).
 *
 * Run (Node 22+, built-in zlib — no npm install), then validate + commit:
 *   node tools/rederive-js-snippets.js
 *   node tools/validate-citations.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('node:zlib');
const { extractCitation } = require('./build-citation-data.js');

const DATA = path.resolve(__dirname, '..', 'src', 'citations', 'data');
const sources = JSON.parse(fs.readFileSync(path.join(DATA, 'sources.json'), 'utf8'));

const htmlCache = {};
function talkHtml(talkId) {
  if (talkId in htmlCache) return htmlCache[talkId];
  let html = null;
  try { html = zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'talks', `${talkId}.html.gz`))).toString('utf8'); } catch (e) { html = null; }
  htmlCache[talkId] = html;
  return html;
}

const dir = path.join(DATA, 'citations');
let changedCites = 0;
let changedFiles = 0;
let missing = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const fp = path.join(dir, file);
  const shard = JSON.parse(fs.readFileSync(fp, 'utf8'));
  let dirty = false;
  for (const [citId, c] of Object.entries(shard.cites)) {
    const src = sources[c.t];
    if (!src || src.c !== 'T') continue; // STPJS only
    const html = talkHtml(c.t);
    if (!html) { missing++; continue; }
    const { snippet } = extractCitation(html, citId);
    if (snippet && snippet !== c.sn) { c.sn = snippet; dirty = true; changedCites++; }
  }
  if (dirty) { fs.writeFileSync(fp, JSON.stringify(shard)); changedFiles++; }
}

console.log(`Rederived STPJS snippets: ${changedCites} citations updated across ${changedFiles} shards.`);
if (missing) console.log(`(${missing} citations had no bundled talk HTML; left unchanged.)`);
