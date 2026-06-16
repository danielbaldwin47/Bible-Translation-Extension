# Bible Translation Side-by-Side

A Chrome extension that shows the **same Bible chapter in other translations**
(NRSV, NIV, NKJV, KJV, …) in a side panel while you read on
[churchofjesuschrist.org/study](https://www.churchofjesuschrist.org/study).

The panel blends into the Gospel Library reader: it mirrors the site's
light/dark/sepia theme, font, and text size, follows you as you navigate between
chapters, and scrolls along with the page.

## Features

- **Auto-detects the chapter** you're reading (Old & New Testament) and loads the
  matching chapter in your chosen translation.
- **Right-side panel**, one translation at a time, switchable from a dropdown.
- **Blends in** — copies the site's resolved colors/fonts via CSS variables, so it
  tracks theme and font-size changes live (no dependence on the site's class names).
- **Synced scrolling** — the panel scrolls proportionally with the main page.
- **Caching + rate-limit handling** so re-reading a chapter is instant and stays
  within the api.bible free-tier limits.
- No build step — plain Manifest V3, load it unpacked.

## Translation sources

Copyrighted translations (NRSV, NIV, NKJV, ESV, …) can't be bundled, so the
extension uses **[scripture.api.bible](https://scripture.api.bible/)** with **your
own free API key**:

1. Sign up at <https://scripture.api.bible/> (Starter plan — free, personal use).
2. On the free plan you can add **up to 3 copyrighted versions** to your key plus
   many public-domain ones.

A second provider, **[bible-api.com](https://bible-api.com/)**, offers
public-domain translations (KJV, ASV, WEB, …) with **no key required**.

> Availability of NRSV/NIV/NKJV depends on what your specific api.bible key is
> granted. The options page shows exactly which versions your key can access.

## Install (load unpacked)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the repo folder.
4. Click the extension's **Settings** (or the ⚙ in the panel) and:
   - Choose a provider (api.bible or bible-api.com).
   - Paste your api.bible key and click **Test key**.
   - Check the translations you want, pick a default, and **Save**.
5. Open any Bible chapter, e.g.
   `https://www.churchofjesuschrist.org/study/scriptures/nt/john/3?lang=eng`.

The toolbar icon toggles the panel; the panel's ⟩ button collapses it to a tab.

## How it works

```
content script  ──messages──►  service worker  ──fetch──►  api.bible / bible-api.com
 (detect chapter,               (owns API key,             (chapter text)
  inject panel,                  caching, rate limits,
  mirror theme,                  normalizes to safe IR)
  sync scroll)   ◄──IR blocks──
```

- The site is a React SPA, so navigation is detected via a history hook +
  `popstate` + a polling fallback (covers strict CSP).
- All network calls go through the **service worker** (which has `host_permissions`),
  avoiding content-script CORS issues and keeping the key out of the page.
- Chapter text is normalized to a small intermediate representation and rendered
  with text nodes only (no `innerHTML`), so there's no XSS surface.

## Project layout

| Path | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest |
| `src/shared/constants.js` | message types, storage keys, limits, defaults |
| `src/shared/books.js` | 66-book LDS-slug → USFM / full-name mapping |
| `src/background/service-worker.js` | message router |
| `src/background/api.js` | api.bible + bible-api.com fetch + normalization |
| `src/background/cache.js` | chapter/bibles cache (chrome.storage.local) |
| `src/background/ratelimit.js` | 15/30s + daily request limiting |
| `src/content/detect.js` | chapter detection + SPA navigation |
| `src/content/theme.js` | theme/font mirroring |
| `src/content/sanitize.js` | safe IR → DOM renderer |
| `src/content/panel.js` | panel UI + scroll-sync |
| `src/content/content.js` | orchestrator |
| `src/options/` | settings page |
| `tools/validate-books.js` | sanity checks (run with `node`) |
| `tools/make-icons.js` | generates optional icon PNGs |

## Development

```bash
node tools/validate-books.js   # verify the book map + manifest file refs
node tools/make-icons.js       # generate icons/*.png (optional, see below)
```

### Optional: a custom toolbar icon

The extension loads fine with Chrome's default icon. To add a custom one, run
`node tools/make-icons.js` and add this block to `manifest.json`:

```json
"icons": {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
}
```

After editing files, reload the extension at `chrome://extensions` (and reload the
Gospel Library tab) to pick up changes.

## Notes & limitations

- Verse numbering differs across translations, so the panel does **not** attempt
  per-verse alignment — scroll-sync is proportional, and whole chapters line up.
- No custom toolbar icon ships by default; generate one with `tools/make-icons.js`
  (see above) or drop in your own art.
- Respect each translation's license terms; this tool is for personal study.
