# Changelog

High-level only. Mechanism lives in module headers, `CONTEXT.md`, and
`docs/adr/`. Versions are the extension's own numbering (`manifest.json`),
starting fresh at 0.x for the first tagged release.

## 0.1.0 — 2026-08-15

Architecture pass over the whole extension plus a batch of panel polish.
No new data; the citation bundle is unchanged.

### For the reader

- **Scroll-sync setting** (Panel card): turn page-follow off entirely.
  Tracking is 1:1 and instant; only re-alignment after you scroll the panel
  yourself eases in, and it always finishes.
- **Citation source marking** (Citations card): acronym chip (GC / JoD / JS)
  or a coloured edge on the group. Chips are one 26px tile family sized from
  their own text, not the site's.
- **Citations open in context** — the cited passage is revealed where it sits,
  not pinned to the top of the panel.
- **Talk reader header sits flush** with the panel body.
- **Theme mirroring** re-applies live when the site's theme or font-size slider
  changes; mirrors the verse body's font, not the chapter heading's.
- Options page stays in sync with panel-side changes (mode, layout, width) and
  its translation list no longer goes stale behind its settings.

### Under the hood

- `src/shared/settings.js` (`__BTX.settings`) is the single owner of synced
  settings: schema, defaults, per-key normalizers, `patch`/`replace`, tagged
  own-writes, unknown keys passed through.
- `panel.js` deepened: owns panel state + persistence, scroll ownership, and a
  view host that caches earned views; `content.js` is an orchestrator only.
- `cit-view-model.js` — pure citation view-model (ordering, grouping, counts,
  labels, filter plan) behind a thin `cit-panel.js` DOM adapter.
- `talk-source.js` — where each corpus's talk text comes from and where to
  scroll in it, as a `CORPUS_PLANS` table under `talk-view.js`.
- `theme.js` owns its re-apply loop (bounded backoff, `ResizeObserver`,
  no-op writes suppressed).
- New Node checks, no deps: `validate-settings`, `validate-panel-state`,
  `validate-cit-view-model`, `validate-options-form`, `validate-theme-align`,
  `test-talk-source`.
- Docs rewritten for agents: `CLAUDE.md` trimmed to rules + pointers,
  `CONTEXT.md` vocabulary, `docs/adr/0006`, `docs/agents/`.

## 0.0.9 — main before this merge

Baseline: Translation + Citations panel for all standard works, inline talk
reader with local highlights, two citation layouts with filter box, options
page, theme/font mirroring, drag-resize, proportional scroll-sync. Tagged
`v0.0.9` on `main` retroactively; no earlier versions were tagged.
