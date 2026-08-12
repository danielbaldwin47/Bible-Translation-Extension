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
  shared/constants.js      __BTX.const  message types, storage keys, API bases, limits, isFreeVersion()
  shared/settings.js       __BTX.settings  THE owner of the `btxSettings` sync object: SCHEMA/KEYS/defaults (apiKey, provider, enabledTranslations, defaultTranslationId, actOnNonEngOnly, sidebarWidth, scrollToSnippet, citationView, showCitationToggle, panelMode, panelCollapsed), one normalizer per setting, normalize/diff (pure), get/patch/replace, subscribe({next,prev,changed,own})
  shared/books.js          __BTX.books  66 Bible (slug→USFM/name) + non-Bible registry (BoM/D&C/PGP); bookFullName, isScriptureCollection, isKnownBook
  background/
    service-worker.js      classic worker; importScripts shared+libs; onMessage router
    api.js                 __BTX.api    api.bible fetch + JSON→IR; copyright backfill; bible-api.com fallback
    cache.js               __BTX.cache  chrome.storage.local chapter/bibles cache + LRU
    ratelimit.js           __BTX.rate   15/30s window + 5000/day, persisted
  content/
    detect.js              __BTX.detect URL parse (all standard works + isBible flag) + SPA nav
    page-hook.js           page-world history patch, injected via web-accessible <script src> (CSP-safe)
    theme.js               __BTX.theme  mirror(resolveTarget) → {refresh}: owns capture/apply of site colors/fonts (+ headerBg/headerH), the launch re-apply backoff (pure nextAlignDelay, module.exports for Node) and the theme/font/resize watching; resolveReadingContainer()
    sanitize.js            __BTX.sanitize  IR → DOM (text nodes only)
    panel.js               __BTX.panel  deep module: owns mode/citation-layout/collapsed/width + their persistence (settings keys panelMode/panelCollapsed/citationView/sidebarWidth), DOM, scroll-sync, drag-resize, AND the view host (view caching/invalidation + sole ownership of body scrollTop). Pure cores (createState/effectiveMode/selectMode/selectCitationView/setBible; createViews/saveViewScroll/selectView/keepView/settleView/dropViews/viewRestoresScroll; scrollStep — module.exports for Node). API: init(handlers) → showChapter/hide, effectiveMode(), citationView(), showView({name,key,cache,render}), scrollIntoView(target,{offset,frames}), showTranslation({kind}), populateTranslations, getRootEl; events: renderMode, onTranslationChange, onGear, onClose, onRetry
    panel.css
    content.js             orchestrator: detect → worker/citations → panel data/content only (no panel state, no theme policy); answers panel's renderMode event; hands theme.mirror a getter for the panel root and calls refresh() once the panel is shown
  citations/
    cit-data.js            __BTX.citData    load/cache shards, sources, gunzip bundled talks; chapterData(slug,chap) → deduped entries + each cite's in-chapter verse span + uniqueTotal
    cit-view-model.js      __BTX.citVM (+ module.exports) PURE, no DOM: buildView(chapterData, {view,fullName,chapter,focusVerse}) → descriptor tree (verse / source-type groups, citation rows, uids, counts, range + summary labels, single-source pre-open); anchorVerses dedup; formatVerses/verseLabel; byFirstVerse/byDateDesc; toolbar state machine (initialState/filterPlan/applyPlan/toggleAllPlan/toggleLabel)
    cit-panel.js           __BTX.citPanel   DOM adapter only (render(host, opts) — fills the container the panel's view host gave it, returns nothing) — builds elements from the descriptor tree and mirrors toolbar plans onto `[data-btx-uid]` nodes (filter box matches row.dataset.btxSearch; expand/collapse-all shown when uniqueTotal >= 4). No ordering/grouping/counting/data-derived labels here; the fixed chrome it does own is the loading + no-results lines, the filter placeholder, and the quote marks around a snippet. talk-view takes verseLabel from citVM directly
    highlights.js          __BTX.highlights local select-to-highlight in the reader; chrome.storage.local; re-apply on reopen
    talk-source.js         __BTX.talkSource load({entry,source}) → {html,url,findTarget(container)}; CORPUS_PLANS table (live vs bundled, scroll target per corpus); pre-2013 GC URL repair (pure pickSessionUrl/bouncedToConference/fullTalkUrl, module.exports for Node tests)
    talk-view.js           __BTX.talkView   inline reader over that seam (open(host, opts) — fills a view-host container): sanitizer, render, highlights, marks the scroll target and asks `panel.scrollIntoView` to reveal it, sticky header ("‹ Back" + "Open full talk" + cited-verse label; Esc = back); footnote-number styling (blue superscripts)
    citations.css
    data/                  GENERATED, committed, shipped (~62 MB, ADR-0003):
      index.json           build meta + per-book counts (88 books)
      sources.json         { talkId: {c,sp,ti,d,lbl,url?} }
      citations/{slug}.json { cites:{citId:{t,v,sn,a?}}, index:{chap:{verse:[citId]}} } (sn for STPJS `T` cites = the body passage, not the reference line)
      talks/{talkId}.html.gz bundled talks (corpora E/J/T)
  options/                 options.html/js/css — three cards: Bible translations (api.bible key/versions/default), Citations (layout, sidebar toggle, scroll-to-snippet), Panel (width, English-only); ids unchanged, options.js wires by id. Pure core (module.exports for Node): initialChecks/pickDefaultId/translationPatch/fillPlan — an untested key writes no translation list, and the dirty flag decides what an external change may repaint
icons/                     icon-{16,32,48,128}.png (generated by tools/make-icons.js)
tools/
  build-citation-data.js   builds src/citations/data/ from the BYU DBs (node:sqlite + zlib); ALL_VOLUMES = {1..5}; extractCitation handles STPJS footnotes; guards require.main + module.exports { extractCitation, stpjsBodyPassage, … }
  rederive-js-snippets.js  rewrites STPJS (corpus T) snippets from the shipped talks/*.html.gz (no DBs needed)
  test-talk-source.js      node:test unit tests for talk-source's DOM-free half (corpus plan, pre-2013 URL repair)
  validate-books.js        asserts the 66-book Bible map + manifest file refs
  validate-settings.js     asserts the settings schema/normalizers/diff, the storage+own-write layer (fake chrome), and that nothing outside src/shared/settings.js touches storage.sync
  validate-options-form.js asserts the options form's pure core (initial checks, default-id pick, the Save patch for the translation list, the fill plan) + that the shell routes through it
  validate-citations.js    asserts generated citation data integrity (>= 88 books)
  validate-theme-align.js  asserts the theme's launch re-apply policy (nextAlignDelay): backoff shape + that it terminates
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
- **Checks:** `node tools/validate-books.js`, `node tools/validate-settings.js`,
  `node tools/validate-citations.js`, `node tools/validate-cit-view-model.js`,
  `node tools/validate-panel-state.js`, `node tools/validate-options-form.js`,
  `node tools/validate-theme-align.js`,
  `node --test tools/test-talk-source.js` (node:test, built in — no framework,
  no deps); syntax: `node --check <file>`. Citations logic is testable only if
  it stays in `cit-view-model.js` — put new ordering/grouping/labelling rules
  there, not in `cit-panel.js`. Same for the panel: mode/toggle semantics and
  the view host's caching rules live in panel.js's pure cores
  (validate-panel-state.js), not the DOM shell. Same for the options page:
  what a Save may write and what an incoming change may repaint live in
  options.js's pure core (validate-options-form.js).

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
  corpus outside the table falls back on whether the talk ships a URL. Its
  `findTarget` runs over the *rendered* talk, so it depends on talk-view's render
  contract: ids survive, classes come back `btxk-`-prefixed, and each footnote
  carries `data-btx-footnum`.
- The STPJS body-passage rule is stated twice (build snippets vs reader scroll
  target) on purpose — ADR-0006 says why and what to change together.
- By-source rows are ordered by first cited verse (`byFirstVerse`); both
  citation layouts start collapsed.
- Settings go through `__BTX.settings` — never `chrome.storage.sync` directly
  (`validate-settings.js` enforces this). `subscribe` reports `changed` (the
  keys that actually moved) and `own` (this context made the write), which is
  how `content.js` skips a re-render for panel-owned keys or for its own
  writes.
- Panel state (mode, citation layout, collapsed, width) has one owner in the
  reader: `__BTX.panel`, persisted through `__BTX.settings` (`panelMode`,
  `panelCollapsed`, `citationView`, `sidebarWidth`). The options page also
  writes `citationView`/`sidebarWidth`; the panel adopts those like any
  external change and fires `renderMode` when they stale its content — unless
  the same write moved a non-panel key, in which case the orchestrator's full
  re-render covers it (its subscriber ignores changes touching only
  `panel.HANDLED_KEYS`, which the panel owns — `content.js` reads that list
  instead of restating it). The options Save uses `SETTINGS.patch`, not
  `replace`, so panel keys absent from the form survive, and the options page
  `subscribe`s so its form adopts what the panel changes while it is open
  (`fillForm(changed)`, skipping fields the user has edited since the last
  Save); otherwise a Save from a stale form would write the old layout/width
  back over the panel's. The form's single-value settings live in one `FIELDS`
  table (key + control + read/write) that Save and `fillForm` share; the
  translation list is not in it (it is built from the key test, not from one
  control) but goes through the same dirty flag and the same `fillPlan`, so an
  external `enabledTranslations` change re-renders it. The old
  `chrome.storage.local` keys
  (`btxPanelMode`/`btxPanelCollapsed`) are migrated once by `panel.init` —
  nothing else may name them (the ownership walk in `validate-settings.js`
  enforces it).
- Panel width persists in `settings.sidebarWidth` (sync). The 280–900 bounds
  live only in `__BTX.settings` (`SIDEBAR_WIDTH_MIN/MAX`); `panel.clampWidth`
  and the options slider read them from there (`clampWidth` adds its own 90%
  viewport cap).
- Every settings write is stamped with a `__btxWrite` tag (how `own` is
  detected) and carries through any key the schema doesn't know, so a newer
  version's setting on another synced machine isn't deleted. Neither is a
  setting, so neither shows up in `diff`.
- SPA navigation is debounced via `currentKey` in `content.js`; panel-initiated
  changes (mode/layout toggles) arrive via the panel's `renderMode` event
  instead, bypassing that dedupe. Reset `currentKey = null` to force a
  re-render.
- View caching lives in the panel's **view host**, not the orchestrator.
  `panel.showView({ name, key, cache, render })` mounts one `.btx-view`
  container into `.btx-body`: same `name` + same `key` re-mounts the cached
  container (so Translation↔Citations preserves open dropdowns and filter text,
  and "‹ Back" out of a talk lands where the list was), a different `key` calls
  `render(container)`. Where it re-mounts *scrolled to* depends on who owns that
  view's scroll — see the ownership bullet below. One
  cache slot per name — `translation` (key = chapter + version), `citations`
  (key = chapter + layout + focus verse), `talk` (`cache: false`, never
  re-mounted). `showChapter` drops every cached view, which covers chapter
  change and the settings re-render. The orchestrator names views and supplies
  keys; it holds no panel DOM.
- A view **earns** its cache slot (`keep` starts `null`, not `true`). Two ways
  to lose it: `showTranslation` marks its own result (`keepView`) — content
  yes, spinner/no-key/error no, so a retry rebuilds — and `settleView` refuses
  a render that threw or left the container empty (a `loadChapter` that bails
  after its await must not cache a blank Translation tab).
- `panel` is the only writer of `.btx-body`'s scrollTop, and `panel.js` has
  exactly one `ui.body.scrollTop =` (`writeBodyScroll`, reached only through
  `setBodyScroll`) — scroll-sync, view placement, restore and `scrollIntoView`
  all route through it. Views ask via
  `panel.scrollIntoView(target, { offset, frames })` (`frames` defers the
  measurement N animation frames for layout to settle) — cit-panel for the
  focus verse, talk-view for the citation scroll target. A scroll aimed at a
  view that has since been swapped out is dropped, not applied to whatever
  replaced it. Same for a slow `render`: it fills a detached container and
  can't paint over the view that replaced it — but `showTranslation` resolves
  its container *late* (whatever is mounted now), so the orchestrator's
  `reqToken` / `effectiveMode()` guards around `loadChapter` are what keep a
  stale chapter response off the wrong view.
- Each view either **owns** its scroll position or is **page-synced**, never
  both — `viewRestoresScroll(name)` in the pure core is the rule (see
  `validate-panel-state.js`). Citations and the talk reader own theirs
  (`saveViewScroll` on the way out, `restoreScroll` on the way back).
  Translation is page-synced: the page scroll is the source of truth, so it
  saves nothing and `placeSyncedView` puts it where the page says. Before this,
  restore and `syncNow` both wrote the body and the next page-scroll frame
  silently undid the restore. `syncNow` refuses to write unless the *page-synced
  view is the mounted one* — a sync firing while Citations is still up (the mode
  toggle re-asserts sync before the orchestrator swaps views) would otherwise
  scroll the citation list and poison the offset it saves on its way out.
- Scroll-sync tracks the page **1:1 and instantly** — one write per page-scroll
  frame, no easing. That is deliberate: the panel should feel like the
  browser's own scrolling, and a damped follow reads as lag. **Exactly one
  move eases: re-alignment.** The user may scroll the panel away from the page;
  `onBodyScrolled` notices (pure `isForeignScroll(actual, expected)` against the
  position `writeBodyScroll` recorded), cancels any animation and sets
  `syncDetached`. While detached the panel is the user's — nothing drags it
  back, which is the bug that made the sidebar feel unscrollable. The next page
  scroll eases it home — deliberately slow enough to read as *"it's scrolling
  back up"* rather than a lurch. Two constants shape that: `SCROLL_TAU_MS`
  (300) is how fast it settles once moving, `SCROLL_RAMP_MS` (260) how long it
  takes to get going. The ramp exists because an exponential chase is fastest
  on its very first frame, which feels like being thrown; pure
  `easeRamp(elapsed, rampMs)` (smoothstep) scales the early frames so the move
  accelerates in and `scrollStep(from, target, dt, tau, ramp)` eases it out.
  Both are normalized on elapsed time, so 60Hz and 120Hz feel the same.
  Retargeting mid-flight keeps `started`, so a target that moves while we
  re-align doesn't restart the ramp and stall the body mid-travel; on arrival
  `syncDetached` clears and tracking is 1:1 again. Everything else is instant: **placement** on mount
  (`placeOnMount` runs it twice, once next frame, because a fresh body is still
  reflowing), `restoreScroll`, and `scrollIntoView` reveals.
- The system `prefers-reduced-motion` signal is deliberately **not** consulted.
  The reader page scrolls smoothly whatever the OS setting says, so honoring it
  in the panel alone would make the two disagree — the panel matches the
  browser, not the OS.
- `refreshScrollSync` is called only where its predicate
  (`visible && !collapsed && effectiveMode === 'translation'`) can move:
  `applyModeUI`, `applyCollapsedUI`, `hide()`. Rendering content is not a state
  change — don't re-assert it from `showTranslation`. On attach it calls
  `syncNow` itself so expanding from collapsed agrees with the page without
  waiting for a scroll event; on a *mode* switch that call is a no-op (Citations
  is still the mounted view, and `syncNow` won't touch it) and `placeSyncedView`
  at mount is what lands it.
- Citations filter: `citVM.filterPlan` decides what hides (`.btx-cit-hidden` on
  non-matching rows and groups left empty), auto-opens surviving groups while
  filtering, and restores the pre-filter open state on clear (`preFilterOpen`,
  captured on the transition into filtering). `cit-panel` only mirrors the plan
  onto `[data-btx-uid]` nodes and feeds the user's own opens back into the
  state via a capture-phase `toggle` listener ('toggle' doesn't bubble).
  Snippets clamp to 3 lines in CSS.
- The talk reader header is position:sticky inside its `.btx-view` (negative
  margins cancel the body padding — `.btx-view` adds no box of its own);
  `talkView.revealTarget` passes an `offset` to `panel.scrollIntoView` so the target
  lands below it. Esc = Back (document-level handler, rebound per open(),
  self-removing when its reader is gone).
- The history hook loads `page-hook.js` via `chrome.runtime.getURL` (the page
  CSP allow-lists our extension origin in `script-src`), not an inline script
  — avoids CSP violations and keeps instant nav detection; the 750ms poll is
  the fallback.
- The panel pins to `top:0`; its header height and background mirror the
  site's sticky toolbar via `--btx-header-h` / `--btx-header-bg`
  (internal `captureHeaderHeight` / `captureHeaderBg`). The toolbar may not be
  laid out at first paint, so the theme module re-applies on a short backoff
  until the height resolves — otherwise the bars misalign until a resize. That
  retry belongs to the theme, not the orchestrator: `theme.mirror(resolveTarget)`
  owns the first apply, the alignment chain and the change watching, and returns
  `{ refresh }`; `content.js` only calls `refresh()` after `showChapter` (a
  target now exists — an alignment chain with nothing mounted stops at once).
  The retry policy is the pure `nextAlignDelay(attempt, aligned)` (see
  `tools/validate-theme-align.js`) — it must terminate, since a page with no
  plausible toolbar never resolves a height. The panel stays put
  when the site header expands (it doesn't track it).
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
