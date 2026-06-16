#!/usr/bin/env node
/*
 * Sanity-check the generated citation dataset under src/citations/data/.
 * Run: node tools/validate-citations.js   (after build-citation-data.js)
 *
 * Verifies: index covers 66 books; every shard's index references resolve to a
 * cite; every cite's talk exists in sources.json; live-GC URLs are church-study
 * URLs; bundled (non-live) talks have a .html.gz file. Exits non-zero on failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA = path.resolve(__dirname, '..', 'src', 'citations', 'data');
let failures = 0;
const check = (cond, msg) => { if (!cond) { console.error('  ✗ ' + msg); failures++; } };
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'));

if (!fs.existsSync(DATA)) {
  console.error(`No data dir at ${DATA}. Run build-citation-data.js first.`);
  process.exit(1);
}

const index = readJSON('index.json');
const sources = readJSON('sources.json');

console.log('Index / sources:');
check(index.counts && index.counts.books === index.books.length, `counts.books matches books[] (${index.counts && index.counts.books} vs ${index.books.length})`);
check(index.counts && index.counts.books >= 88, `index covers all standard works, >= 88 books (got ${index.counts && index.counts.books})`);
check(index.counts.citations > 100000, `citation count is sane (${index.counts.citations})`);
check(Object.keys(sources).length > 1000, `sources populated (${Object.keys(sources).length})`);

console.log('Shards:');
let totalCites = 0;
let bundledMissing = 0;
let badUrls = 0;
const bundledChecked = new Set();
for (const b of index.books) {
  const shard = readJSON(`citations/${b.slug}.json`);
  // every indexed citId resolves to a cite, and its talk exists in sources
  for (const ch of Object.keys(shard.index)) {
    for (const v of Object.keys(shard.index[ch])) {
      for (const citId of shard.index[ch][v]) {
        const c = shard.cites[citId];
        if (!c) { check(false, `${b.slug} ${ch}:${v} citId ${citId} missing from cites`); continue; }
        const src = sources[c.t];
        if (!src) { check(false, `${b.slug} cite ${citId} -> talk ${c.t} not in sources`); continue; }
        totalCites++;
        // For live GC the url must be a church study URL; otherwise a bundled
        // file must exist. Spot-check a bounded number to keep this fast.
        if (src.url) {
          if (!/^https:\/\/www\.churchofjesuschrist\.org\/study\//.test(src.url)) badUrls++;
        } else if (!bundledChecked.has(c.t)) {
          bundledChecked.add(c.t);
          if (!fs.existsSync(path.join(DATA, 'talks', `${c.t}.html.gz`))) bundledMissing++;
        }
      }
    }
  }
}
check(totalCites > 50000, `walked citations (${totalCites})`);
check(badUrls === 0, `all live-GC URLs are church study URLs (${badUrls} bad)`);
check(bundledMissing === 0, `all bundled talks have a .html.gz (${bundledMissing} missing)`);

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log(`\nAll checks passed. ${totalCites} citations, ${Object.keys(sources).length} sources, ${bundledChecked.size} bundled talks verified.`);
