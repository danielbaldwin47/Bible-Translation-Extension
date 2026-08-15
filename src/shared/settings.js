/*
 * The one owner of the extension's synced settings (`chrome.storage.sync`,
 * key `btxSettings`). Nothing else reads or writes that object directly.
 *
 * It owns four things:
 *   - the schema        (SCHEMA / KEYS / defaults)
 *   - normalization     (exactly one normalizer per setting — no per-caller
 *                        `x === 'verse' ? … : …` coercions scattered around)
 *   - reads and writes  (get / patch / replace, with an in-context cache)
 *   - change notification (subscribe, which reports *which* keys changed and
 *                        whether this context is the one that wrote them)
 *
 * Consumers are thin adapters: the content script, the options page and the
 * service worker each just call this module.
 *
 * Authored as an IIFE on `__BTX.settings` with a `module.exports` guard (see
 * ADR-0002) so the pure parts are Node-testable (`tools/validate-settings.js`)
 * and the same file loads verbatim in a content script, the options page and
 * the classic service worker.
 */
(function (root) {
  'use strict';

  const C = (root.__BTX && root.__BTX.const)
    || (typeof require === 'function' ? require('./constants.js') : null);

  // Panel width bounds — the one source of truth. `clampWidth` in
  // src/content/panel.js and the options slider both read these.
  const SIDEBAR_WIDTH_MIN = 280;
  const SIDEBAR_WIDTH_MAX = 900;
  const SIDEBAR_WIDTH_DEFAULT = 380;

  // Body text-size multiplier bounds — the one source of truth; the options
  // slider reads them. 1 means "exactly the size the site is showing"; the
  // range is deliberately narrow, since the base size is already the reader's
  // own site setting, not a fixed default.
  const FONT_SCALE_MIN = 0.7;
  const FONT_SCALE_MAX = 1.6;
  const FONT_SCALE_STEP = 0.1;
  const FONT_SCALE_DEFAULT = 1;

  // ---- Per-setting normalizers -------------------------------------------
  // Each takes the raw stored value and returns a valid one. They are total:
  // any garbage (missing, wrong type, legacy string) maps to the default.

  function str(fallback) {
    return (v) => (typeof v === 'string' ? v.trim() : fallback);
  }

  // Legacy semantics: a boolean setting reads as its default unless it is
  // stored as exactly the opposite boolean.
  function bool(fallback) {
    return (v) => (typeof v === 'boolean' ? v : fallback);
  }

  function oneOf(allowed, fallback) {
    return (v) => (allowed.includes(v) ? v : fallback);
  }

  function clampedInt(min, max, fallback) {
    return (v) => {
      // Only a number or a numeric string counts; null/''/true would otherwise
      // coerce to 0 and silently clamp to the minimum instead of the default.
      let n = NaN;
      if (typeof v === 'number') n = v;
      else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(min, Math.min(max, Math.round(n)));
    };
  }

  // Like clampedInt, but snapped to a fractional step grid rather than to whole
  // numbers. The snap is measured from `min` so every reachable value sits on
  // the same grid the stepper and the slider walk, and the result is rounded
  // off the float dust a 0.1 grid produces (0.7 + 5 * 0.1 = 1.2000000000000002)
  // — otherwise the same value written by two contexts would not compare equal
  // and `diff` would report a change that never happened.
  function clampedStep(min, max, step, fallback) {
    return (v) => {
      let n = NaN;
      if (typeof v === 'number') n = v;
      else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      const clamped = Math.max(min, Math.min(max, n));
      return Number((min + Math.round((clamped - min) / step) * step).toFixed(4));
    };
  }

  // Enabled translations are [{ id, name, abbr, provider, copyright }] rows
  // that came back from the provider; the only invariant we enforce is a
  // usable id, since that is what every lookup keys on.
  function translationList(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((t) => t && typeof t === 'object' && typeof t.id === 'string' && t.id !== '');
  }

  // Loaded after constants.js in every context (manifest content_scripts,
  // importScripts, options.html), so a missing `C` is a load-order bug.
  const APIBIBLE = C.PROVIDER_APIBIBLE;
  const BIBLEAPI = C.PROVIDER_BIBLEAPI;

  // ---- Schema -------------------------------------------------------------
  // One entry per setting: its default and its single normalizer.
  const SCHEMA = {
    apiKey: { def: '', norm: str('') },
    provider: { def: APIBIBLE, norm: oneOf([APIBIBLE, BIBLEAPI], APIBIBLE) },
    enabledTranslations: { def: [], norm: translationList },
    defaultTranslationId: { def: '', norm: str('') },
    // Only act on English pages (the site serves other languages too).
    actOnNonEngOnly: { def: true, norm: bool(true) },
    sidebarWidth: {
      def: SIDEBAR_WIDTH_DEFAULT,
      norm: clampedInt(SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_DEFAULT),
    },
    // The reader's own text-size multiplier for the panel *body* (translation,
    // citation list, talk reader). It multiplies the size theme.js mirrors from
    // the site rather than replacing it, so the site's font-size slider and this
    // setting compose instead of fighting. Panel chrome is not affected.
    fontScale: {
      def: FONT_SCALE_DEFAULT,
      norm: clampedStep(FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP, FONT_SCALE_DEFAULT),
    },
    // Open sources scrolled to the cited paragraph.
    scrollToSnippet: { def: true, norm: bool(true) },
    // Citation layout. One documented default, used by every context.
    citationView: { def: 'source', norm: oneOf(['source', 'verse'], 'source') },
    // Show the citation-layout sub-toggle in the panel.
    showCitationToggle: { def: true, norm: bool(true) },
    // How a citation row shows its source type: 'chip' = an acronym tile (GC /
    // JoD / JS) at the right of each row; 'strip' = no tile, the source-type
    // group carries a coloured left edge instead and the text reclaims the width.
    citationSourceMark: { def: 'strip', norm: oneOf(['chip', 'strip'], 'strip') },
    // Let the page's scroll move the Translation panel. Off means the panel
    // never scrolls on its own — no tracking, no eased re-alignment; where the
    // user puts it is where it stays.
    scrollSync: { def: true, norm: bool(true) },
    // The panel's own state: preferred mode on Bible chapters, and whether the
    // panel is collapsed to its edge tab. Owned and written by __BTX.panel.
    panelMode: { def: 'translation', norm: oneOf(['translation', 'citations'], 'translation') },
    panelCollapsed: { def: false, norm: bool(false) },
  };

  const KEYS = Object.keys(SCHEMA);

  function defaults() {
    const out = {};
    for (const k of KEYS) out[k] = SCHEMA[k].norm(SCHEMA[k].def);
    return out;
  }

  // Full, valid settings object from anything at all. Unknown keys are dropped.
  function normalize(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const out = {};
    for (const k of KEYS) {
      out[k] = SCHEMA[k].norm(Object.prototype.hasOwnProperty.call(src, k) ? src[k] : SCHEMA[k].def);
    }
    return out;
  }

  // Which settings actually differ between two (raw or normalized) objects.
  // Normalizing first means two spellings of the same value never register as
  // a change — this is what lets callers ask "did anything besides the width
  // change?" without a bespoke comparison.
  function diff(a, b) {
    const na = normalize(a);
    const nb = normalize(b);
    return KEYS.filter((k) => JSON.stringify(na[k]) !== JSON.stringify(nb[k]));
  }

  // ---- Storage ------------------------------------------------------------
  // Everything below needs `chrome.storage`; in Node only the pure parts above
  // are exercised.

  const KEY = C.SETTINGS_KEY;
  const AREA = 'sync';

  // Stamped onto every write so a change event can be matched back to the
  // context that caused it. Not a setting: it is stripped on read and ignored
  // by `diff`, so it never looks like a change.
  const WRITE_TAG = '__btxWrite';
  const CONTEXT_ID = Math.random().toString(36).slice(2, 10);
  let writeSeq = 0;

  let cache = null; // last known normalized settings for this context
  // The value subscribers were last told about. Tracked separately from
  // `cache` because a write updates the cache immediately (so a read right
  // after a write is correct) while the change event only arrives later — and
  // that event's "what changed" has to be measured against what subscribers
  // last saw, not against the value we just optimistically cached.
  let lastNotified = null;
  const listeners = new Set();
  // Write tags this context has issued but not yet seen echoed back through
  // storage.onChanged, so a subscriber can tell its own write from someone
  // else's. Bounded: a write whose echo never arrives must not leak.
  const pendingOwnWrites = [];
  const MAX_PENDING = 8;
  // Keys in the stored object that aren't ours — a setting written by a newer
  // (or older) version of the extension on another synced machine. We don't
  // understand them, so we carry them through our writes untouched rather than
  // deleting someone else's data.
  let extras = {};
  let wired = false;

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage[AREA];
  }

  function readRaw() {
    return new Promise((resolve) => {
      try {
        chrome.storage[AREA].get(KEY, (data) => {
          if (chrome.runtime && chrome.runtime.lastError) resolve({});
          else resolve((data && data[KEY]) || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  // Resolves true on success. A failed write (sync quota, most likely) must not
  // leave this context believing it stored something it didn't.
  function writeRaw(value) {
    return new Promise((resolve) => {
      try {
        chrome.storage[AREA].set({ [KEY]: value }, () => {
          resolve(!(chrome.runtime && chrome.runtime.lastError));
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  // Remember any key in the stored object that isn't ours, so our next write
  // carries it through instead of dropping it.
  function rememberExtras(raw) {
    if (!raw || typeof raw !== 'object') return;
    const out = {};
    for (const k of Object.keys(raw)) {
      if (k !== WRITE_TAG && !Object.prototype.hasOwnProperty.call(SCHEMA, k)) out[k] = raw[k];
    }
    extras = out;
  }

  // True (and consumes the record) if this change event is the echo of a write
  // we made. Matched on the write tag we stamped, not on the value — two
  // contexts writing the same value are then still told apart.
  function claimOwnWrite(raw) {
    const tag = raw && typeof raw === 'object' ? raw[WRITE_TAG] : undefined;
    if (!tag) return false;
    const i = pendingOwnWrites.indexOf(tag);
    if (i === -1) return false;
    pendingOwnWrites.splice(i, 1);
    return true;
  }

  function wire() {
    if (wired || !hasStorage() || !chrome.storage.onChanged) return;
    wired = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== AREA || !changes[KEY]) return;
      const raw = changes[KEY].newValue;
      const next = normalize(raw);
      const prev = lastNotified || normalize(changes[KEY].oldValue);
      rememberExtras(raw);
      cache = next;
      lastNotified = next;
      // Consume the echo record even when nothing changed, so a stale record
      // can't be claimed by a later, unrelated change.
      const own = claimOwnWrite(raw);
      const changed = diff(prev, next);
      if (!changed.length) return; // a re-save of identical values is not a change
      for (const fn of Array.from(listeners)) {
        try { fn({ next: normalize(next), prev, changed, own }); } catch (e) { /* one bad listener shouldn't stop the rest */ }
      }
    });
  }

  // Current settings, normalized. Cached per context and kept fresh by the
  // onChanged listener, so callers can call this freely. Returns a fresh object
  // each time — the cache is this module's, not the caller's.
  async function get() {
    wire();
    if (cache) return normalize(cache);
    if (hasStorage()) {
      const raw = await readRaw();
      rememberExtras(raw);
      cache = normalize(raw);
    } else {
      cache = defaults();
    }
    if (!lastNotified) lastNotified = cache;
    return normalize(cache);
  }

  async function write(next) {
    wire();
    const before = cache;
    cache = next;
    if (!hasStorage()) return next;
    const tag = `${CONTEXT_ID}:${++writeSeq}`;
    pendingOwnWrites.push(tag);
    while (pendingOwnWrites.length > MAX_PENDING) pendingOwnWrites.shift();
    // Unknown keys ride along untouched; the tag rides along so we recognize
    // the echo. Neither is a setting, so neither can register as a change.
    const ok = await writeRaw(Object.assign({}, extras, next, { [WRITE_TAG]: tag }));
    if (!ok) {
      // The write never landed: drop the optimistic cache and the echo record
      // rather than let later read-modify-writes build on a phantom value.
      cache = before;
      const i = pendingOwnWrites.indexOf(tag);
      if (i !== -1) pendingOwnWrites.splice(i, 1);
      return before || defaults();
    }
    return next;
  }

  // Change some settings, leaving the rest alone. Read-modify-write against
  // the freshest value we have, so two contexts patching different fields
  // don't clobber each other the way ad-hoc read/modify/write cycles did.
  async function patch(partial) {
    const current = await get();
    return write(normalize(Object.assign({}, current, partial || {})));
  }

  // Replace the whole object (the options page's Save). Missing fields go back
  // to their defaults.
  async function replace(value) {
    await get(); // make sure the listener is wired before we write
    return write(normalize(value));
  }

  // fn({ next, prev, changed, own }) on every change to the stored settings:
  //   changed — the keys that actually differ (never empty)
  //   own     — true when this context made the write, so a caller that
  //             already applied the change locally can skip re-applying it
  // Returns an unsubscribe function.
  function subscribe(fn) {
    wire();
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  const SETTINGS = {
    SCHEMA,
    KEYS,
    SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX,
    FONT_SCALE_MIN,
    FONT_SCALE_MAX,
    FONT_SCALE_STEP,
    defaults,
    normalize,
    diff,
    get,
    patch,
    replace,
    subscribe,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SETTINGS;
  root.__BTX = Object.assign(root.__BTX || {}, { settings: SETTINGS });
})(typeof globalThis !== 'undefined' ? globalThis : this);
