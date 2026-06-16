/*
 * Book mapping: LDS scripture URL slug -> USFM code (api.bible) and full name
 * (bible-api.com). Slugs verified against the live churchofjesuschrist.org
 * /study/scriptures/ot and /nt table of contents.
 *
 * Same IIFE/namespace pattern as constants.js so it loads in every context.
 */
(function (root) {
  'use strict';

  // LDS URL slug -> USFM 3-letter code used by api.bible chapter ids (e.g. MAT.5).
  const LDS_TO_USFM = {
    // Old Testament (39)
    gen: 'GEN', ex: 'EXO', lev: 'LEV', num: 'NUM', deut: 'DEU',
    josh: 'JOS', judg: 'JDG', ruth: 'RUT', '1-sam': '1SA', '2-sam': '2SA',
    '1-kgs': '1KI', '2-kgs': '2KI', '1-chr': '1CH', '2-chr': '2CH', ezra: 'EZR',
    neh: 'NEH', esth: 'EST', job: 'JOB', ps: 'PSA', prov: 'PRO',
    eccl: 'ECC', song: 'SNG', isa: 'ISA', jer: 'JER', lam: 'LAM',
    ezek: 'EZK', dan: 'DAN', hosea: 'HOS', joel: 'JOL', amos: 'AMO',
    obad: 'OBA', jonah: 'JON', micah: 'MIC', nahum: 'NAM', hab: 'HAB',
    zeph: 'ZEP', hag: 'HAG', zech: 'ZEC', mal: 'MAL',
    // New Testament (27)
    matt: 'MAT', mark: 'MRK', luke: 'LUK', john: 'JHN', acts: 'ACT',
    rom: 'ROM', '1-cor': '1CO', '2-cor': '2CO', gal: 'GAL', eph: 'EPH',
    philip: 'PHP', col: 'COL', '1-thes': '1TH', '2-thes': '2TH', '1-tim': '1TI',
    '2-tim': '2TI', titus: 'TIT', philem: 'PHM', heb: 'HEB', james: 'JAS',
    '1-pet': '1PE', '2-pet': '2PE', '1-jn': '1JN', '2-jn': '2JN', '3-jn': '3JN',
    jude: 'JUD', rev: 'REV',
  };

  // LDS URL slug -> full English book name (used by bible-api.com queries).
  const LDS_TO_BIBLEAPI = {
    gen: 'Genesis', ex: 'Exodus', lev: 'Leviticus', num: 'Numbers', deut: 'Deuteronomy',
    josh: 'Joshua', judg: 'Judges', ruth: 'Ruth', '1-sam': '1 Samuel', '2-sam': '2 Samuel',
    '1-kgs': '1 Kings', '2-kgs': '2 Kings', '1-chr': '1 Chronicles', '2-chr': '2 Chronicles', ezra: 'Ezra',
    neh: 'Nehemiah', esth: 'Esther', job: 'Job', ps: 'Psalms', prov: 'Proverbs',
    eccl: 'Ecclesiastes', song: 'Song of Solomon', isa: 'Isaiah', jer: 'Jeremiah', lam: 'Lamentations',
    ezek: 'Ezekiel', dan: 'Daniel', hosea: 'Hosea', joel: 'Joel', amos: 'Amos',
    obad: 'Obadiah', jonah: 'Jonah', micah: 'Micah', nahum: 'Nahum', hab: 'Habakkuk',
    zeph: 'Zephaniah', hag: 'Haggai', zech: 'Zechariah', mal: 'Malachi',
    matt: 'Matthew', mark: 'Mark', luke: 'Luke', john: 'John', acts: 'Acts',
    rom: 'Romans', '1-cor': '1 Corinthians', '2-cor': '2 Corinthians', gal: 'Galatians', eph: 'Ephesians',
    philip: 'Philippians', col: 'Colossians', '1-thes': '1 Thessalonians', '2-thes': '2 Thessalonians', '1-tim': '1 Timothy',
    '2-tim': '2 Timothy', titus: 'Titus', philem: 'Philemon', heb: 'Hebrews', james: 'James',
    '1-pet': '1 Peter', '2-pet': '2 Peter', '1-jn': '1 John', '2-jn': '2 John', '3-jn': '3 John',
    jude: 'Jude', rev: 'Revelation',
  };

  // Non-Bible standard works: LDS URL slug -> full name. These have no api.bible
  // translation (citations only). Slugs match churchofjesuschrist.org URLs (and,
  // after space→hyphen normalization, the BYU SCI book.Abbr — except D&C, whose
  // DB Abbr is "sec" but whose Church slug is "dc"). Only chapter-based books are
  // listed (0-chapter front matter / facsimiles are omitted).
  const BOFM_NAMES = {
    '1-ne': '1 Nephi', '2-ne': '2 Nephi', jacob: 'Jacob', enos: 'Enos', jarom: 'Jarom',
    omni: 'Omni', 'w-of-m': 'Words of Mormon', mosiah: 'Mosiah', alma: 'Alma', hel: 'Helaman',
    '3-ne': '3 Nephi', '4-ne': '4 Nephi', morm: 'Mormon', ether: 'Ether', moro: 'Moroni',
  };
  const DC_NAMES = { dc: 'Doctrine & Covenants', od: 'Official Declarations' };
  const PGP_NAMES = {
    moses: 'Moses', abr: 'Abraham', 'js-m': 'Joseph Smith—Matthew',
    'js-h': 'Joseph Smith—History', 'a-of-f': 'Articles of Faith',
  };
  const NON_BIBLE_NAMES = Object.assign({}, BOFM_NAMES, DC_NAMES, PGP_NAMES);

  // Non-Bible slug -> URL collection segment.
  const SLUG_TO_COLLECTION = {};
  for (const s of Object.keys(BOFM_NAMES)) SLUG_TO_COLLECTION[s] = 'bofm';
  for (const s of Object.keys(DC_NAMES)) SLUG_TO_COLLECTION[s] = 'dc-testament';
  for (const s of Object.keys(PGP_NAMES)) SLUG_TO_COLLECTION[s] = 'pgp';

  function ldsToUsfm(slug) {
    return Object.prototype.hasOwnProperty.call(LDS_TO_USFM, slug) ? LDS_TO_USFM[slug] : null;
  }

  function ldsToBibleApi(slug) {
    return Object.prototype.hasOwnProperty.call(LDS_TO_BIBLEAPI, slug) ? LDS_TO_BIBLEAPI[slug] : null;
  }

  // Display name for any standard-works book (Bible or otherwise).
  function bookFullName(slug) {
    if (Object.prototype.hasOwnProperty.call(LDS_TO_BIBLEAPI, slug)) return LDS_TO_BIBLEAPI[slug];
    if (Object.prototype.hasOwnProperty.call(NON_BIBLE_NAMES, slug)) return NON_BIBLE_NAMES[slug];
    return null;
  }

  // Only the Bible collections (Old/New Testament) have translations.
  function isBibleCollection(collection) {
    return collection === 'ot' || collection === 'nt';
  }

  // All standard-works collections the citation index covers.
  function isScriptureCollection(collection) {
    return collection === 'ot' || collection === 'nt' ||
      collection === 'bofm' || collection === 'dc-testament' || collection === 'pgp';
  }

  // True if (collection, slug) is a known, citation-indexed book.
  function isKnownBook(collection, slug) {
    if (isBibleCollection(collection)) return ldsToUsfm(slug) != null;
    return Object.prototype.hasOwnProperty.call(NON_BIBLE_NAMES, slug) && SLUG_TO_COLLECTION[slug] === collection;
  }

  const BOOKS = {
    LDS_TO_USFM, LDS_TO_BIBLEAPI, NON_BIBLE_NAMES, SLUG_TO_COLLECTION,
    ldsToUsfm, ldsToBibleApi, bookFullName,
    isBibleCollection, isScriptureCollection, isKnownBook,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BOOKS;
  root.__BTX = Object.assign(root.__BTX || {}, { books: BOOKS });
})(typeof globalThis !== 'undefined' ? globalThis : this);
