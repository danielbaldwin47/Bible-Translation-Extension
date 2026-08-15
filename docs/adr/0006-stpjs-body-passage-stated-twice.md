# The STPJS body-passage rule is stated twice (build and view), on purpose

STPJS (corpus `T`) puts its citation spans in a bottom footnote list and marks
the annotated body text with `<span class="footRef">N</span>`. One domain rule —
*a `T` cite means the body passage its footnote annotates, not the footnote's
reference line* (CONTEXT.md, "Body passage") — is implemented twice:

- `tools/build-citation-data.js` → `stpjsBodyPassage(html, num)`: Node, regex
  over the **raw** DB HTML, producing snippet **text** at build time.
- `src/citations/talk-source.js` → `bodyPassageForFootnote(container, note)`:
  browser, DOM query over the **sanitized, class-namespaced** (`btxk-*`) talk,
  producing a scroll-target **element** at read time.

They are not shared because neither input nor output is shared: the build has no
DOM and never sees the namespaced classes, the reader has no raw HTML and needs a
node rather than a string, and the shipped data (ADR-0003) is generated from a
Node script with no bundler to link the two (ADR-0002). Factoring out a common
helper would mean either shipping a DOM shim into the build or re-parsing raw
HTML in the content script — cost with no payoff for a ~10-line rule.

The obligation this creates: if the rule changes (which body element counts, how
the footnote number is found), change **both**, and re-run
`node tools/rederive-js-snippets.js` so the shipped snippets match what the
reader scrolls to. Each implementation carries a comment pointing at this ADR.
