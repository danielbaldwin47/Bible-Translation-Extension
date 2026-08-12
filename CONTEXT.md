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
Which of the panel's two features is showing: Translation (Bible only) or
Citations (all standard works). On non-Bible books only Citations exists and
the mode toggle is hidden.

**Citation layout**:
How the Citations mode arranges rows: **by verse** (verse → source-type group →
talks) or **by source** (one deduped row per talk, grouped by source type).
Stored as the `citationView` setting; flippable live via the in-panel
sub-toggle.
_Avoid_: view (bare)

**Citation row**:
One rendered `.btx-cit` row in the panel. In by-verse layout a row is one cite
occurrence; in by-source layout rows are deduped to one per talk.

**Highlight**:
A user-made local text highlight inside the inline talk reader. Stored in
`chrome.storage.local` on this machine only — never synced to a Church
account.
_Avoid_: annotation (the Church site's own feature, which the extension never touches)

**IR**:
The normalized JSON intermediate representation a fetched translation chapter
is reduced to before rendering; the sanitizer renders only from IR, never raw
HTML.
