/*
 * Shared constants for the Bible Translation extension.
 *
 * Authored as an IIFE that attaches to a single namespace (`__BTX.const`) so the
 * exact same file works verbatim in every context with no build step:
 *   - content script  (listed in manifest content_scripts, isolated world)
 *   - service worker  (pulled in via importScripts)
 *   - options page    (plain <script src>)
 *   - node validator  (via module.exports)
 */
(function (root) {
  'use strict';

  const CONST = {
    // --- API endpoints ---
    API_BIBLE_BASE: 'https://api.scripture.api.bible/v1',
    BIBLE_API_BASE: 'https://bible-api.com',

    // --- Providers ---
    PROVIDER_APIBIBLE: 'api.bible',
    PROVIDER_BIBLEAPI: 'bible-api.com',

    // --- Message types (content <-> worker) ---
    MSG: {
      GET_ENABLED_TRANSLATIONS: 'GET_ENABLED_TRANSLATIONS',
      GET_CHAPTER: 'GET_CHAPTER',
      LIST_BIBLES: 'LIST_BIBLES',
      OPEN_OPTIONS: 'OPEN_OPTIONS',
      TOGGLE_PANEL: 'TOGGLE_PANEL',
    },

    // --- Error codes returned in { error: { code } } ---
    ERR: {
      NO_KEY: 'NO_KEY',
      RATE_LIMITED: 'RATE_LIMITED',
      NOT_FOUND: 'NOT_FOUND',
      NETWORK: 'NETWORK',
      FORBIDDEN: 'FORBIDDEN',
      INVALID_KEY: 'INVALID_KEY',
      UNKNOWN: 'UNKNOWN',
    },

    // --- chrome.storage.sync keys (settings) ---
    SETTINGS_KEY: 'btxSettings',

    // --- chrome.storage.local key prefixes (cache + rate limiting) ---
    CACHE_PREFIX: 'chapter::',
    CACHE_INDEX_KEY: 'btxCacheIndex',
    BIBLES_CACHE_KEY: 'btxBiblesCache',
    RATE_RECENT_KEY: 'btxRateRecent',
    RATE_DAILY_PREFIX: 'btxRateDaily::',

    // --- Cache TTLs (ms) ---
    CHAPTER_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days (chapters are static)
    BIBLES_TTL_MS: 24 * 60 * 60 * 1000, // 1 day
    CACHE_MAX_ENTRIES: 500,

    // --- Rate limits (api.bible) ---
    RATE_WINDOW_MS: 30 * 1000,
    RATE_WINDOW_MAX: 15, // 15 requests / 30s
    RATE_DAILY_MAX: 5000, // 5000 requests / day

    // --- Default translations to pre-select in options (best-effort match) ---
    DEFAULT_ABBRS: ['NRSV', 'NIV', 'NKJV'],

    // --- Public-domain translations available on bible-api.com (no key) ---
    BIBLE_API_TRANSLATIONS: [
      { id: 'web', abbr: 'WEB', name: 'World English Bible' },
      { id: 'kjv', abbr: 'KJV', name: 'King James Version' },
      { id: 'asv', abbr: 'ASV', name: 'American Standard Version (1901)' },
      { id: 'bbe', abbr: 'BBE', name: 'Bible in Basic English' },
      { id: 'darby', abbr: 'DARBY', name: 'Darby Bible' },
      { id: 'dra', abbr: 'DRA', name: 'Douay-Rheims 1899 American Edition' },
      { id: 'ylt', abbr: 'YLT', name: "Young's Literal Translation (NT only)" },
      { id: 'oeb-us', abbr: 'OEB-US', name: 'Open English Bible, US Edition' },
      { id: 'webbe', abbr: 'WEBBE', name: 'World English Bible, British Edition' },
    ],

    // Default settings object shape.
    defaultSettings() {
      return {
        apiKey: '',
        provider: 'api.bible',
        enabledTranslations: [], // [{ id, name, abbr, provider, copyright }]
        defaultTranslationId: '',
        actOnNonEngOnly: true,
        sidebarWidth: 380, // panel width in px (also adjustable by dragging)
        scrollToSnippet: true, // open sources scrolled to the cited paragraph
        citationView: 'source', // citations layout: 'source' (group by source) | 'verse' (group by verse)
        showCitationToggle: true, // show the citation-layout toggle in the sidebar
      };
    },

    // Heuristic: is a version free/open (public domain or Creative Commons)?
    // Used to hide the free versions and surface only the copyrighted ones the
    // user added to their api.bible key. Unknown/empty copyright -> treated as
    // not-free (shown), so we never hide a wanted version we couldn't classify.
    isFreeVersion(copyrightText) {
      if (!copyrightText) return false;
      return /public domain|creative commons|\bcc[\s-]?(by|0)/i.test(String(copyrightText));
    },
  };

  // Expose to whichever context loaded this file.
  if (typeof module !== 'undefined' && module.exports) module.exports = CONST;
  root.__BTX = Object.assign(root.__BTX || {}, { const: CONST });
})(typeof globalThis !== 'undefined' ? globalThis : this);
