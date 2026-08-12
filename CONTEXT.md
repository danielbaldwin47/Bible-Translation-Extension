# Translations & Citations

Domain glossary for the Chrome extension that augments the scripture reader on
`churchofjesuschrist.org/study` with alternate Bible translations and BYU
Scripture Citation Index data. This file defines what the words mean; file
layout, rules, and commands live in `CLAUDE.md`.

## Scripture geography

**Standard works**:
The five scripture collections the extension covers: Old Testament, New
Testament, Book of Mormon, Doctrine & Covenants, Pearl of Great Price.

**Volume**:
One of the five standard-works collections. In the BYU data this is
`book.ParentBookID` (1 OT, 2 NT, 3 BoM, 4 D&C, 5 PGP).
_Avoid_: collection (that word is reserved for the URL segment, e.g. `bofm`, `dc-testament`, `pgp`)

**Slug**:
The Church-site URL identifier for a book (`john`, `alma`, `dc`). Also the key
for per-book shard files. D&C "chapters" are section numbers.
_Avoid_: book id, abbreviation

**USFM**:
The industry 3-letter book code (`JHN`, `GEN`) used only when talking to
api.bible. Bible books have both a slug and a USFM code; non-Bible books have
only a slug.

## Citation data

**Cite**:
One record from the BYU Scripture Citation Index: talk X cites verse(s) Y.
Keyed by `citId` in a shard's `cites` map. This is the unit `uniqueTotal`
counts.
_Avoid_: citation (overloaded — use cite for the data record, citation span for the HTML marker, citation row for the panel row)

**Citation span**:
The `<span class="citation" id="{citId}">` marker inside a talk's HTML where
the scripture reference appears. The reader scrolls to it (except STPJS, which
scrolls to the body passage).

**Talk**:
One sermon/discourse/chapter of teachings, identified by `talkId`; its metadata
(speaker, title, date, URL) lives in `sources.json`. Many cites can point at
one talk.
_Avoid_: source, sermon

**Corpus**:
Single-letter provenance tag on a talk: `G` modern General Conference
(1971–present, fetched live), `E` early GC (1942–70), `J` Journal of
Discourses, `T` Teachings of the Prophet Joseph Smith (E/J/T are bundled).

**Source type**:
The panel's grouping of corpora: "General Conference" (G+E), "Journal of
Discourses" (J), "Teachings of the Prophet Joseph Smith" (T). A
**source-type group** is the collapsible panel section for one of these.
_Avoid_: source (bare — say source type, talk, or BYU DBs depending on which you mean)

**BYU DBs**:
The gitignored build inputs `core.53.db` (index) and `content.53.db` (talk
HTML), living in `source-data/`. Needed only to regenerate shipped data.
_Avoid_: source databases, the source

**Shard**:
One generated per-book JSON file, `src/citations/data/citations/{slug}.json`,
holding that book's cites and a chapter→verse→citId index.

**Bundled talk / live talk**:
A bundled talk ships offline as `talks/{talkId}.html.gz` (corpora E/J/T); a
live talk (corpus G) is fetched from the Church site when opened.

**Talk source**:
The seam (`__BTX.talkSource`, `src/citations/talk-source.js`) that answers one
question for the reader: given a cite, hand back displayable talk HTML plus a
way to locate that cite's **scroll target** in the rendered result. It owns the
**corpus plan** — the per-corpus table of where the HTML comes from (live vs
bundled) and what the scroll target is (paragraph anchor / citation span / body
passage).
_Avoid_: source (bare — that still means a source type or the BYU DBs); always say talk source

**Scroll target**:
The element in a rendered talk the reader scrolls to and marks for a cite:
the paragraph anchor (live GC), the citation span (bundled E/J), or the body
passage (STPJS).

**Snippet**:
The short excerpt shown under a citation row. Normally the text around the
citation span; for STPJS (`T`) it is the body passage instead.

**Body passage**:
In STPJS talks, the sentence(s) the footnote annotates — the text around the
matching `footRef` marker, not the footnote's reference line. STPJS snippets
and reader scroll both target it.

**Contiguous range**:
A run of consecutive verses covered by one cite (e.g. vv. 3–5).

**Anchor verse**:
The first verse of each contiguous range a cite covers. In the by-verse layout
a cite appears once per anchor verse, not under every verse in the range.

**uniqueTotal**:
The count of distinct cites in a chapter — the panel's headline number. A
verse chip counts distinct cites anchored at that verse.

## Panel

**Mode**:
The user's preferred panel feature on Bible chapters: Translation (Bible only)
or Citations (all standard works). Stored as the `panelMode` setting, owned by
the panel.

**Effective mode**:
The mode actually showing. Equals the mode on Bible chapters; on non-Bible
books only Citations exists, so citations is forced and the mode toggle is
hidden — the stored preference survives untouched. `panel.effectiveMode()` is
the one source of truth.

**View**:
One named body of panel content that can be mounted in the panel body:
`translation`, `citations`, or `talk` (the inline reader). Exactly one is
mounted at a time.

**View key**:
The string identifying *which content* a view is showing — chapter + version
for translation, chapter + citation layout (+ focus verse, if any) for
citations. Same name and same key means the mounted DOM is still valid; a
different key means rebuild. The orchestrator supplies keys, the view host
compares them. A view only becomes re-mountable once it has earned it: a
spinner, an error, or a render that painted nothing is never cached.

**View host**:
The part of `__BTX.panel` that mounts views: it holds one cached body per view
name, remembers where each *scroll-owning* view was scrolled, invalidates them
all on a new chapter, and is the only writer of the panel body's scroll
position. Callers name a view and say how to build it (`showView`) or ask for a
node to be scrolled into sight (`scrollTo`); no module outside the panel holds
panel DOM.

**Page-synced view**:
A view whose scroll position is dictated by the reader page rather than by the
view itself — today, only Translation, which mirrors the page as the user
scrolls it. A page-synced view saves no offset and is never restored to one: it
is **placed** against the page each time it mounts. Every other view
(Citations, the talk reader) is *scroll-owning* — it saves where it was left
and comes back there. Exactly one of the two applies to any view, which is what
keeps scroll-sync and scroll-restore from writing the same body.

A reader who doesn't want the panel moving on its own turns **scroll-sync**
off (the `scrollSync` setting, on by default). That is not a milder follow: it
removes the page as a driver entirely — no tracking, no re-alignment — so
there is no page-synced view left and Translation becomes scroll-owning like
the rest. Where the user puts the panel is where it stays, including across a
trip to Citations and back.

**Placement**:
Putting a view's body at its starting scroll position at the moment it mounts,
as opposed to *moving* an already-visible body. Placement is instant: a body
that just appeared has no previous on-screen position to move from.

**Detached** (of a page-synced view):
The state where the user has scrolled the panel away from the position the page
points at. A detached panel is the user's: scroll-sync stops writing to it, so
it never fights their scrolling. The next page scroll **re-aligns** it — the
one movement in the panel that eases rather than happening instantly, since the
body may have a long way to travel back. On arrival it is attached again and
tracks the page 1:1.

What eases is only the **gap** — how far the user took the panel from where the
page points. Page scrolling that continues through a re-alignment is mirrored
1:1 as always, so the gap closes on its own fixed schedule however long the
user keeps scrolling; the panel never trails the page.

**Citation layout**:
How the Citations mode arranges rows: **by verse** (verse → source-type group →
talks) or **by source** (one deduped row per talk, grouped by source type).
Stored as the `citationView` setting; flippable live via the in-panel
sub-toggle.
_Avoid_: view (bare — that is a hosted panel view; the `citationView` setting
name predates the term)

**Citation row**:
One rendered `.btx-cit` row in the panel. In by-verse layout a row is one cite
occurrence; in by-source layout rows are deduped to one per talk.

**Citation view-model**:
The pure module (`src/citations/cit-view-model.js`, `__BTX.citVM`) that turns a
chapter's cites into descriptors. Every ordering, grouping, counting,
open-state and data-derived label rule of Citations mode lives there;
`cit-panel` only builds elements from what it returns, and owns nothing beyond
fixed chrome (the loading and no-results lines, the filter placeholder, the
quote marks around a snippet).
_Avoid_: renderer, formatter

**Descriptor**:
A plain object describing one thing the panel will render, carrying a **uid**
stable within one built view-model. A group descriptor (verse or source-type)
carries its label, count chip and pre-open flag; a citation-row descriptor
carries the speaker, corpus tag, range badge, snippet and filter haystack. The
uid is how the DOM adapter maps element ↔ descriptor (`data-btx-uid`) and how
toolbar state is keyed.

**Plan**:
The computed next state of the citations toolbar — which rows and groups hide,
which groups open, what the expand/collapse-all button reads — returned by the
view-model and applied by the panel. Filter clearing restores the open state
captured when filtering began.

**Highlight**:
A user-made local text highlight inside the inline talk reader. Stored in
`chrome.storage.local` on this machine only — never synced to a Church
account.
_Avoid_: annotation (the Church site's own feature, which the extension never touches)

**IR**:
The normalized JSON intermediate representation a fetched translation chapter
is reduced to before rendering; the sanitizer renders only from IR, never raw
HTML.

## Settings

**Setting**:
One user preference in the synced `btxSettings` object (`chrome.storage.sync`)
— api key, enabled translations, citation layout, panel mode, panel width,
collapsed, … Owned end-to-end by `__BTX.settings`: schema, defaults,
normalization, reads, writes and change events. The panel's own state
(`panelMode`, `panelCollapsed`, `citationView`, `sidebarWidth`) is settings
too: in the reader only `__BTX.panel` writes it, and the panel adopts any
external write (the options page edits `citationView`/`sidebarWidth` as one).
What stays per-machine in `chrome.storage.local` (selected translation,
highlights) is *not* a setting.
_Avoid_: config, preference (as a code term)

**Normalizer**:
The single function that turns a setting's raw stored value — missing, legacy,
corrupted, wrong type — into a valid one. Exactly one per setting, so every
context resolves the same stored bytes to the same value.

**Own write**:
A settings change made by the context now being notified of it. Chrome echoes
a write back to its own author, so `subscribe` flags it (`own: true`) and a
caller that already applied the change locally can skip re-applying it.
