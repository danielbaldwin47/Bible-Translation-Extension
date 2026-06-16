# CLAUDE.md

Guidance for working in this repo. Read this first.

## What this is

A **Manifest V3 Chrome extension** (personal, load-unpacked) that augments the
reader on `churchofjesuschrist.org/study` when viewing **any standard-works
chapter** (OT/NT, Book of Mormon, D&C, Pearl of Great Price). One side panel:

1. **Translation** (Bible OT/NT only) — shows the same chapter in another version
   (NIV, NKJV, NRSV, KJV, …) fetched from **scripture.api.bible** using the user's
   own API key.
2. **Citations** (all books) — shows which **General Conference talks, Journal of
   Discourses sermons, and Teachings of Joseph Smith cite each verse** (BYU
   Scripture Citation Index data), grouped per verse → by source type, and opens
   those sources inline. On non-Bible books only Citations exists (no translation),
   so the mode toggle is hidden.

In the inline talk reader the user can **select text to make local highlights**
(stored in `chrome.storage.local` on this machine — not synced to a Church
account; re-applied when the talk reopens). The panel mirrors the site's theme
(light/dark/sepia), font, and size, scroll-syncs (translation mode), and its width
is configurable (options slider + drag the left edge). Personal use only (api.bible
+ BYU/Church content are not redistributable → **not** for the Chrome Web Store).

Active branch: `claude/adoring-pasteur-vqa80n`.

## Hard rules / conventions

- **No build step for the extension.** Plain HTML/CSS/JS, loaded unpacked. Do not
  introduce bundlers/TS for the extension itself.
- **Module pattern:** every JS file is an IIFE that attaches to a single global
  namespace `__BTX.<name>` (and `module.exports` for Node validators). The service
  worker pulls shared files via `importScripts` (so it stays a *classic* worker —
  no `"type":"module"`). Content scripts are listed in dependency order in
  `manifest.json`; `options.html` loads shared files via `<script src>` first.
- **No secrets/CORS in content scripts.** All api.bible calls go through the
  **service worker** (it holds the key and has `host_permissions`). The citation
  feature is content-script-only (static web-accessible data + same-origin GC fetch).
- **Safe rendering:** never `innerHTML` untrusted text. Translations render from a
  normalized JSON IR via `src/content/sanitize.js`; fetched talk HTML is run
  through an allowlist sanitizer in `src/citations/talk-view.js`.
- **Theme/DOM hooks are class-name-agnostic.** The site's classes are hashed;
  read resolved computed styles / stable hooks instead (see `src/content/theme.js`).

## Layout

```
manifest.json              MV3 (v1.2.0); content_scripts order matters
src/
  shared/constants.js      __BTX.const  message types, storage keys, API bases, limits, defaultSettings (sidebarWidth, scrollToSnippet, …), isFreeVersion()
  shared/books.js          __BTX.books  66 Bible (slug→USFM/name) + non-Bible registry (BoM/D&C/PGP); bookFullName, isScriptureCollection, isKnownBook
  background/
    service-worker.js      classic worker; importScripts shared+libs; onMessage router
    api.js                 __BTX.api    api.bible fetch + JSON→IR; copyright backfill; bible-api.com fallback
    cache.js               __BTX.cache  chrome.storage.local chapter/bibles cache + LRU
    ratelimit.js           __BTX.rate   15/30s window + 5000/day, persisted
  content/
    detect.js              __BTX.detect URL parse (all standard works + isBible flag) + SPA nav
    page-hook.js           page-world history patch, injected via web-accessible <script src> (CSP-safe)
    theme.js               __BTX.theme  mirror site colors/fonts (+ headerBg); resolveReadingContainer()
    sanitize.js            __BTX.sanitize  IR → DOM (text nodes only)
    panel.js               __BTX.panel  panel DOM, states, mode toggle, scroll-sync, setWidth + drag-resize, setBibleMode
    panel.css
    content.js             orchestrator: detect → worker/citations → panel; mode (citations-only on non-Bible), width persistence
  citations/
    cit-data.js            __BTX.citData    load/cache shards, sources, gunzip bundled talks
    cit-panel.js           __BTX.citPanel   accordion: verse <details> → source-type <details> → talk rows
    highlights.js          __BTX.highlights local select-to-highlight in the reader; chrome.storage.local; re-apply on reopen
    talk-view.js           __BTX.talkView   inline reader (live GC / bundled), sanitizer, scroll-to-citation, header "Open full talk"
    citations.css
    data/                  GENERATED, committed, shipped (~62 MB):
      index.json           build meta + per-book counts (88 books)
      sources.json         { talkId: {c,sp,ti,d,lbl,url?} }
      citations/{slug}.json { cites:{citId:{t,v,sn,a?}}, index:{chap:{verse:[citId]}} }
      talks/{talkId}.html.gz gzipped offline text for JoD / pre-1971 GC / Joseph Smith
  options/                 options.html/js/css — api.bible key, versions, panel width
icons/                     icon-{16,32,48,128}.png (generated by tools/make-icons.js)
tools/
  build-citation-data.js   builds src/citations/data/ from the app DBs (node:sqlite + zlib); ALL_VOLUMES = {1..5}
  validate-books.js        asserts the 66-book Bible map + manifest file refs
  validate-citations.js    asserts generated citation data integrity (>= 88 books)
  make-icons.js            regenerates icons
source-data/               GITIGNORED build input: core.53.db / content.53.db
```

## Data model notes (BYU SCI)

- Source DBs: `core.53.db` (~44 MB index) + `content.53.db` (~54 MB zlib HTML);
  `TalkID` joins them. **Not shipped** — gitignored in `source-data/`, but present
  in git/LFS history at the "Add BYU citation index databases" commit.
- `book.ParentBookID` = volume: 1 OT, 2 NT, 3 Book of Mormon, 4 D&C, 5 Pearl of
  Great Price. The build covers all five (`ALL_VOLUMES`); ~125.8k citations / 88
  book shards.
- `talk.Corpus`: `G` modern GC (1971–present, on the Church site → fetched live),
  `E` early GC (1942–70), `J` Journal of Discourses, `T` Joseph Smith (E/J/T bundled).
  In the panel, G+E group under "General Conference", J under "Journal of
  Discourses", T under "Teachings of the Prophet Joseph Smith".
- Citations are marked in talk HTML as `<span class="citation" id="{citation.ID}">`;
  modern-GC paragraphs carry `uri=".../slug.p21"` → deep-link anchors.
- DB `book.Abbr` == our LDS slug after `space→hyphen` normalization for nearly all
  books; the one alias is **D&C `sec` → `dc`** (`ABBR_ALIAS` in the build). D&C
  "chapters" are section numbers (1–138); collection URL segment is `dc-testament`.
- GC URL transform: `lds.org/ensign/...` → `churchofjesuschrist.org/study/ensign/...`;
  modern entries already store full church URLs.
- The build is verse-keyed (`citation_verse`): ~0.22% of citations have no verse
  row (almost all are deliberately-skipped front matter — title page, intros,
  witnesses, facsimiles; plus ~65 section-wide refs in shipped books) and aren't
  shown.

## Build / test / verify

- **Load:** `chrome://extensions` → Developer mode → Load unpacked → repo root.
- **Translation:** open `nt/john/3`, add an api.bible key via the ⚙ options page,
  enable versions, pick a default.
- **Citations:** toggle the panel to Citations; expand a verse dropdown → a
  source-type dropdown → a talk to read inline. Also works on non-Bible books
  (e.g. `bofm/alma/5`, `dc-testament/dc/76`, `pgp/moses/1`) where only Citations
  shows. In the reader, select text to make a local highlight (click it to remove).
- **Regenerate citation data** (DBs must be in `source-data/`):
  ```
  node --experimental-sqlite tools/build-citation-data.js   # reads source-data/ by default
  node tools/validate-citations.js
  ```
  Inspect raw DBs first with `--inspect` if formats may have changed.
- **Checks:** `node tools/validate-books.js`, `node tools/validate-citations.js`;
  syntax: `node --check <file>` (no test runner).

## Gotchas / not yet verified in a real browser

- In-text verse badges were removed (they cluttered the reading); the per-verse
  count now lives on the panel's verse dropdown only.
- Local highlights anchor to a top-level block's `id` (sanitizer preserves ids)
  with block index as fallback + char offsets + quoted text for verification; if a
  block's text shifts, that highlight is skipped on re-apply rather than misplaced.
  The site's own annotations/account are untouched (not feasible from the panel).
- Non-Bible book slugs/URL segments (`bofm`, `dc-testament`, `pgp`) and the
  `dc-testament/dc/{section}` shape are assumed from convention — confirm on a live
  page; `detect.parseLocation` gates on `BOOKS.isKnownBook`.
- Live-GC paragraph scroll is best-effort (matches the paragraph anchor); bundled
  E/J/T scroll to the exact citation span.
- Panel width persists in `settings.sidebarWidth` (sync). A width-only change skips
  the heavy translation re-render (`sameExceptWidth` in `content.js`).
- SPA navigation is debounced via `currentKey` in `content.js`; mode toggles re-render
  directly (bypassing that dedupe). Reset `currentKey = null` to force a re-render.
- The citations view is cached (`citCache` in `content.js`) so toggling
  Translation↔Citations preserves scroll + open dropdowns; invalidated on chapter
  change / settings re-render. `cit-panel.render` returns the wrapper node it builds.
- The history hook loads `page-hook.js` via `chrome.runtime.getURL` (the page CSP
  allow-lists our extension origin in `script-src`), not an inline script — avoids
  CSP violations and keeps instant nav detection; the 750ms poll is the fallback.
- The panel pins to `top:0` and its header mirrors the site's sticky-toolbar grey
  (`--btx-header-bg` from `theme.captureHeaderBg`, exact if a solid `<header>` bg
  is readable, else a derived shade) so the title bar lines up with the site's icon
  row. It stays put when the site header expands (it doesn't track it).
- Commits here are unsigned (no signing key in the container) → GitHub shows
  "Unverified"; author email is `noreply@anthropic.com`. The git proxy port rotates
  and occasionally drops — retry pushes; clear any stale `remote.origin.pushurl`.
```
