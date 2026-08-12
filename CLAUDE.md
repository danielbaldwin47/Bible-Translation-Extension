# CLAUDE.md

Guidance for working in this repo. Read this first. Domain terms (cite, talk,
corpus, source type, anchor verse, snippet, …) are defined in **`CONTEXT.md`**
— use its vocabulary. Hard-to-reverse decisions and their reasoning live in
**`docs/adr/`**; check them before proposing structural changes.

## What this is

A **Manifest V3 Chrome extension** (personal, load-unpacked) that augments the
reader on `churchofjesuschrist.org/study` for any standard-works chapter. One
side panel, two modes:

1. **Translation** (Bible only) — the same chapter in another version (NIV,
   NKJV, …) fetched from **scripture.api.bible** with the user's own key.
2. **Citations** (all standard works) — which talks cite each verse (BYU
   Scripture Citation Index data), in two citation layouts (by verse / by
   source) flippable via an in-panel sub-toggle. Talks open inline; the reader
   supports local highlights.

The panel mirrors the site's theme/font/size, scroll-syncs in Translation
mode, and has configurable width (options slider + drag the left edge).
Personal use only — api.bible + BYU/Church content are not redistributable, so
**never** the Chrome Web Store (ADR-0003).

## Hard rules / conventions

- **No build step for the extension.** Plain HTML/CSS/JS, loaded unpacked. No
  bundlers/TS for the extension itself (ADR-0002).
- **Module pattern:** every JS file is an IIFE attaching to the single global
  `__BTX.<name>` (plus `module.exports` for Node validators). The service
  worker stays a *classic* worker (`importScripts`, no `"type":"module"`).
  Content scripts are listed in dependency order in `manifest.json`;
  `options.html` loads shared files via `<script src>` first (ADR-0002).
- **No secrets/CORS in content scripts.** All api.bible calls go through the
  **service worker** (it holds the key and has `host_permissions`). The
  citation feature is content-script-only (static web-accessible data +
  same-origin GC fetch).
- **Safe rendering:** never `innerHTML` untrusted text. Translations render
  from IR via `src/content/sanitize.js`; fetched talk HTML goes through the
  allowlist sanitizer in `src/citations/talk-view.js`.
- **Theme/DOM hooks are class-name-agnostic** — read computed styles / stable
  hooks, the site's classes are hashed (ADR-0005; see `src/content/theme.js`).
- **Highlights stay local** — `chrome.storage.local`, never the Church
  account or sync storage (ADR-0004).

## Layout

```
manifest.json              MV3 (v1.3.0, "Translations & Citations for Gospel Library"); content_scripts order matters
src/
  shared/constants.js      __BTX.const  message types, storage keys, API bases, limits, defaultSettings (sidebarWidth, scrollToSnippet, citationView, showCitationToggle, …), isFreeVersion()
  shared/books.js          __BTX.books  66 Bible (slug→USFM/name) + non-Bible registry (BoM/D&C/PGP); bookFullName, isScriptureCollection, isKnownBook
  background/
    service-worker.js      classic worker; importScripts shared+libs; onMessage router
    api.js                 __BTX.api    api.bible fetch + JSON→IR; copyright backfill; bible-api.com fallback
    cache.js               __BTX.cache  chrome.storage.local chapter/bibles cache + LRU
    ratelimit.js           __BTX.rate   15/30s window + 5000/day, persisted
  content/
    detect.js              __BTX.detect URL parse (all standard works + isBible flag) + SPA nav
    page-hook.js           page-world history patch, injected via web-accessible <script src> (CSP-safe)
    theme.js               __BTX.theme  mirror site colors/fonts (+ headerBg); resolveReadingContainer(); captureHeaderHeight/headerHeightKnown
    sanitize.js            __BTX.sanitize  IR → DOM (text nodes only)
    panel.js               __BTX.panel  panel DOM, states, mode toggle + citation-layout sub-toggle (setCitationView/setCitationToggleEnabled), scroll-sync, setWidth + drag-resize, setBibleMode; setCollapsed fires onCollapsedChange (collapsed state persisted by content.js)
    panel.css
    content.js             orchestrator: detect → worker/citations → panel; mode (citations-only on non-Bible), width persistence; citationView; applyThemeUntilAligned (re-applies theme at launch until the site toolbar height resolves)
  citations/
    cit-data.js            __BTX.citData    load/cache shards, sources, gunzip bundled talks; chapterData(slug,chap) → deduped entries + each cite's in-chapter verse span + uniqueTotal
    cit-panel.js           __BTX.citPanel   two layouts (renderByVerse/renderBySource); anchorVerses dedup; formatVerses/verseLabel range labels (verseLabel exported, used by talk-view); renderByVerse pre-opens the source-type group for single-source verses; attachTools = filter box (matches speaker/title/label/snippet via row.dataset.btxSearch) + expand/collapse-all button (shown when uniqueTotal >= 4)
    highlights.js          __BTX.highlights local select-to-highlight in the reader; chrome.storage.local; re-apply on reopen
    talk-source.js         __BTX.talkSource load({entry,source}) → {html,url,live,findTarget(container)}; CORPUS_PLANS table (live vs bundled, scroll target per corpus); pre-2013 GC URL repair (pure pickSessionUrl/bouncedToConference/fullTalkUrl, module.exports for Node tests)
    talk-view.js           __BTX.talkView   inline reader over that seam: sanitizer, render, highlights, generic scroll-to-target, sticky header ("‹ Back" + "Open full talk" + cited-verse label; Esc = back); footnote-number styling (blue superscripts)
    citations.css
    data/                  GENERATED, committed, shipped (~62 MB, ADR-0003):
      index.json           build meta + per-book counts (88 books)
      sources.json         { talkId: {c,sp,ti,d,lbl,url?} }
      citations/{slug}.json { cites:{citId:{t,v,sn,a?}}, index:{chap:{verse:[citId]}} } (sn for STPJS `T` cites = the body passage, not the reference line)
      talks/{talkId}.html.gz bundled talks (corpora E/J/T)
  options/                 options.html/js/css — three cards: Bible translations (api.bible key/versions/default), Citations (layout, sidebar toggle, scroll-to-snippet), Panel (width, English-only); ids unchanged, options.js wires by id
icons/                     icon-{16,32,48,128}.png (generated by tools/make-icons.js)
tools/
  build-citation-data.js   builds src/citations/data/ from the BYU DBs (node:sqlite + zlib); ALL_VOLUMES = {1..5}; extractCitation handles STPJS footnotes; guards require.main + module.exports { extractCitation, stpjsBodyPassage, … }
  rederive-js-snippets.js  rewrites STPJS (corpus T) snippets from the shipped talks/*.html.gz (no DBs needed)
  validate-books.js        asserts the 66-book Bible map + manifest file refs
  validate-citations.js    asserts generated citation data integrity (>= 88 books)
  make-icons.js            regenerates icons
source-data/               GITIGNORED build input: the BYU DBs
```

## BYU data facts

- The BYU DBs: `core.53.db` (~44 MB index) + `content.53.db` (~54 MB zlib
  HTML), joined on `TalkID`. Gitignored, but present in git/LFS history at the
  "Add BYU citation index databases" commit.
- The build covers all five volumes: ~125.8k cites across 88 shards. It is
  verse-keyed (ADR-0001) — the ~0.22% of cites with no verse row aren't shown.
- Citation spans: `<span class="citation" id="{citId}">` in talk HTML;
  modern-GC paragraphs carry `uri=".../slug.p21"` deep-link anchors.
- **STPJS markup differs:** citation spans sit in a bottom footnote list
  (`<div class="footnote">N. <span class="citation">…</span></div>`) with body
  markers `<span class="footRef">N</span>`; `stpjsBodyPassage` derives the
  body passage from the matching `footRef`. JoD/GC carry inline citation spans.
- DB `book.Abbr` == our slug after space→hyphen normalization; the one alias
  is D&C `sec` → `dc` (`ABBR_ALIAS` in the build).
- GC URL transform: `lds.org/ensign/...` →
  `churchofjesuschrist.org/study/ensign/...`; modern entries already store
  full church URLs.

## Build / test / verify

- **Load:** `chrome://extensions` → Developer mode → Load unpacked → repo root.
- **Translation:** open `nt/john/3`, add an api.bible key via the ⚙ options
  page, enable versions, pick a default.
- **Citations:** toggle the panel to Citations; expand a verse → a source-type
  group → a talk reads inline. Also works on non-Bible books (`bofm/alma/5`,
  `dc-testament/dc/76`, `pgp/moses/1`). In the reader, select text to
  highlight (click a highlight to remove it).
- **Regenerate citation data** (BYU DBs must be in `source-data/`):
  ```
  node --experimental-sqlite tools/build-citation-data.js   # reads source-data/ by default
  node tools/validate-citations.js
  ```
  Inspect raw DBs first with `--inspect` if formats may have changed.
- **Regenerate only STPJS snippets** from shipped data (no DBs needed):
  ```
  node tools/rederive-js-snippets.js
  node tools/validate-citations.js
  ```
- **Checks:** `node tools/validate-books.js`, `node tools/validate-citations.js`,
  `node --test tools/test-talk-source.js` (node:test, built in — no framework,
  no deps); syntax: `node --check <file>`.

## Gotchas

- Highlights anchor to a top-level block's `id` (the sanitizer preserves ids),
  falling back to block index + char offsets + quoted text for verification;
  if a block's text shifts, that highlight is skipped on re-apply rather than
  misplaced.
- Non-Bible slugs/URL segments (`bofm`, `dc-testament`, `pgp`) and the
  `dc-testament/dc/{section}` shape are assumed from convention — confirm on a
  live page; `detect.parseLocation` gates on `BOOKS.isKnownBook`.
- Reader scroll targets by corpus live in one table, `CORPUS_PLANS` in
  `talk-source.js`: live GC is best-effort (paragraph anchor, citation span as
  fallback); bundled J/E scroll to the exact citation span; STPJS scrolls to the
  body passage, not the footnote-list span. Corpus comes from `source.c`; a
  corpus outside the table falls back on whether the talk ships a URL.
- The STPJS body-passage rule is stated twice (build snippets vs reader scroll
  target) on purpose — ADR-0006 says why and what to change together.
- By-source rows are ordered by first cited verse (`byFirstVerse`); both
  citation layouts start collapsed.
- Panel width persists in `settings.sidebarWidth` (sync). A width-only change
  skips the heavy translation re-render (`sameExceptWidth` in `content.js`).
- SPA navigation is debounced via `currentKey` in `content.js`; mode toggles
  re-render directly (bypassing that dedupe). Reset `currentKey = null` to
  force a re-render.
- The citations view is cached (`citCache` in `content.js`) so toggling
  Translation↔Citations preserves scroll, open dropdowns, and filter text;
  invalidated on chapter change / settings re-render. `cit-panel.render`
  returns the wrapper node it builds.
- Citations filter: hides non-matching `.btx-cit` rows and empty `details`
  groups (`.btx-cit-hidden`), auto-opens surviving groups while filtering,
  restores pre-filter open state on clear (`preFilterOpen`). The
  expand/collapse-all label updates via a capture-phase `toggle` listener
  ('toggle' doesn't bubble). Snippets clamp to 3 lines in CSS.
- The talk reader header is position:sticky inside `.btx-body` (negative
  margins cancel the body padding); `scrollToCitation` takes an `offset` so
  the target lands below it. Esc = Back (document-level handler, rebound per
  open(), self-removing when its reader is gone). Panel collapsed state
  persists in `chrome.storage.local` (`btxPanelCollapsed`).
- The history hook loads `page-hook.js` via `chrome.runtime.getURL` (the page
  CSP allow-lists our extension origin in `script-src`), not an inline script
  — avoids CSP violations and keeps instant nav detection; the 750ms poll is
  the fallback.
- The panel pins to `top:0`; its header height and background mirror the
  site's sticky toolbar via `--btx-header-h` / `--btx-header-bg`
  (`theme.captureHeaderHeight` / `captureHeaderBg`). The toolbar may not be
  laid out at first paint, so `content.js applyThemeUntilAligned` re-applies
  the theme on a short backoff until `theme.headerHeightKnown()` — otherwise
  the bars misalign until a resize. The panel stays put when the site header
  expands (it doesn't track it).
- Commits here are unsigned (no signing key in the container) → GitHub shows
  "Unverified"; author email is `noreply@anthropic.com`. The git proxy port
  rotates and occasionally drops — retry pushes; clear any stale
  `remote.origin.pushurl`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `danielbaldwin47/Translations-and-Citations`, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each using its default label string. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
