#!/usr/bin/env node
/*
 * No-build sanity checks. Run: node tools/validate-books.js
 *
 *  1. The book map covers exactly the 39 OT + 27 NT books, with valid, unique
 *     USFM codes and matching entries in the bible-api name map.
 *  2. Every file referenced by manifest.json actually exists on disk.
 *
 * Exits non-zero on any failure so it can gate a commit.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const books = require(path.join(ROOT, 'src/shared/books.js'));

let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); failures++; }
}

const OT = ['gen','ex','lev','num','deut','josh','judg','ruth','1-sam','2-sam','1-kgs','2-kgs','1-chr','2-chr','ezra','neh','esth','job','ps','prov','eccl','song','isa','jer','lam','ezek','dan','hosea','joel','amos','obad','jonah','micah','nahum','hab','zeph','hag','zech','mal'];
const NT = ['matt','mark','luke','john','acts','rom','1-cor','2-cor','gal','eph','philip','col','1-thes','2-thes','1-tim','2-tim','titus','philem','heb','james','1-pet','2-pet','1-jn','2-jn','3-jn','jude','rev'];
const USFM = ['GEN','EXO','LEV','NUM','DEU','JOS','JDG','RUT','1SA','2SA','1KI','2KI','1CH','2CH','EZR','NEH','EST','JOB','PSA','PRO','ECC','SNG','ISA','JER','LAM','EZK','DAN','HOS','JOL','AMO','OBA','JON','MIC','NAM','HAB','ZEP','HAG','ZEC','MAL','MAT','MRK','LUK','JHN','ACT','ROM','1CO','2CO','GAL','EPH','PHP','COL','1TH','2TH','1TI','2TI','TIT','PHM','HEB','JAS','1PE','2PE','1JN','2JN','3JN','JUD','REV'];

const allSlugs = OT.concat(NT);

console.log('Book map:');
const usfmKeys = Object.keys(books.LDS_TO_USFM);
check(usfmKeys.length === 66, `LDS_TO_USFM has 66 entries (got ${usfmKeys.length})`);
for (const slug of allSlugs) check(books.ldsToUsfm(slug), `LDS_TO_USFM missing slug "${slug}"`);
for (const k of usfmKeys) check(allSlugs.includes(k), `LDS_TO_USFM has unexpected slug "${k}"`);

const mappedUsfm = allSlugs.map((s) => books.ldsToUsfm(s));
check(new Set(mappedUsfm).size === 66, 'USFM codes are unique');
for (const u of mappedUsfm) check(USFM.includes(u), `USFM "${u}" is not a recognized code`);

for (const slug of allSlugs) check(books.ldsToBibleApi(slug), `LDS_TO_BIBLEAPI missing slug "${slug}"`);

const spot = { gen: 'GEN', ps: 'PSA', song: 'SNG', '1-jn': '1JN', philem: 'PHM', matt: 'MAT', rev: 'REV', ezek: 'EZK' };
for (const [slug, code] of Object.entries(spot)) {
  check(books.ldsToUsfm(slug) === code, `spot-check ${slug} -> ${code} (got ${books.ldsToUsfm(slug)})`);
}

check(books.isBibleCollection('ot') && books.isBibleCollection('nt'), 'ot/nt are Bible collections');
check(!books.isBibleCollection('bofm') && !books.isBibleCollection('pgp'), 'bofm/pgp are not Bible collections');

console.log('Manifest files:');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const refs = [
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  manifest.options_ui.page,
  ...Object.values(manifest.icons || {}),
];
for (const ref of refs) check(fs.existsSync(path.join(ROOT, ref)), `manifest references missing file "${ref}"`);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
