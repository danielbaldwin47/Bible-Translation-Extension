# Bible Translation Side-by-Side + Scripture Citation Index

A Chrome study extension for [churchofjesuschrist.org/study](https://www.churchofjesuschrist.org/study)
that, while you read a Bible chapter, shows (1) the **same chapter in other
translations** (NRSV, NIV, NKJV, KJV, …) and (2) every **General Conference talk,
Journal of Discourses sermon, and Teaching of Joseph Smith that cites each verse**
— all in a side panel that blends into the Gospel Library reader.

The panel mirrors the site's light/dark/sepia theme, font, and text size, follows
you as you navigate between chapters, and scrolls along with the page.

## Features

- **Two modes** in one panel, toggled in the header: **Translation** and **Citations**.
- **Translation** — auto-detects the chapter and loads it in your chosen version;
  one at a time, switchable from a dropdown; scrolls proportionally with the page.
- **Citations** — for the current chapter, lists the talks/sermons that cite each
  verse (grouped by verse, newest first, with a context snippet). Per-verse count
  **badges** also appear in the Church's text; click one to jump to that verse.
- **Open sources inline** — clicking a citation opens the talk in the panel,
  scrolled to the cited paragraph: modern General Conference is fetched live from
  churchofjesuschrist.org; Journal of Discourses / pre-1971 conference / Joseph
  Smith come from bundled offline text.
- **Blends in** — copies the site's resolved colors/fonts via CSS variables, so it
  tracks theme and font-size changes live (no dependence on the site's class names).
- **Caching + rate-limit handling** for translations; citation data is local.
- No build step for the extension — plain Manifest V3, load it unpacked.

## Scripture Citation Index data

The citation feature is powered by data extracted from the BYU "Scripture Citation
Index" app databases (`core.53.db`, `content.53.db`), processed by
`tools/build-citation-data.js` into the compact, web-fetchable bundle under
`src/citations/data/`. This is for **personal study only** (BYU/Church content is
not redistributable — another reason this stays a load-unpacked extension, not a
Web Store listing). To regenerate after updating the app DBs:

```
node --experimental-sqlite tools/build-citation-data.js --core ./core.53.db --content ./content.53.db
node tools/validate-citations.js
```

## Translation sources

Copyrighted translations (NIV, NKJV, NRSV, ESV, …) can't be bundled, so the
extension uses **[scripture.api.bible](https://scripture.api.bible/)** with **your
own free API key**:

1. Sign up at <https://scripture.api.bible/> (Starter plan — free, personal use).
2. On the free plan you can add **up to 3 copyrighted versions** to your key
   (e.g. NIV, NKJV, NIRV) plus many public-domain ones.

> The options page lists only the **copyrighted versions you added** to your key
> (the free public-domain ones are hidden, since the goal is to compare other
> mainstream translations). Availability depends on what your key is granted —
> NRSV, for example, isn't currently in the api.bible catalog.

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
| `tools/make-icons.js` | regenerates the icon PNGs |

## Development

```bash
node tools/validate-books.js   # verify the book map + manifest file refs
node tools/make-icons.js       # regenerate icons/*.png
```

After editing files, reload the extension at `chrome://extensions` (and reload the
Gospel Library tab) to pick up changes.

## Notes & limitations

- Verse numbering differs across translations, so the panel does **not** attempt
  per-verse alignment — scroll-sync is proportional, and whole chapters line up.
- The icons are generated by `tools/make-icons.js`; replace `icons/*.png` with your
  own art if you like.
- Respect each translation's license terms; this tool is for personal study.
