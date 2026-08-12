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

  // Panel width bounds. Must match `clampWidth` in src/content/panel.js and the
  // range input in src/options/options.html.
  const SIDEBAR_WIDTH_MIN = 280;
  const SIDEBAR_WIDTH_MAX = 900;
  const SIDEBAR_WIDTH_DEFAULT = 380;

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

  // Enabled translations are [{ id, name, abbr, provider, copyright }] rows
  // that came back from the provider; the only invariant we enforce is a
  // usable id, since that is what every lookup keys on.
  function translationList(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((t) => t && typeof t === 'object' && typeof t.id === 'string' && t.id !== '');
  }

  const APIBIBLE = C ? C.PROVIDER_APIBIBLE : 'api.bible';
  const BIBLEAPI = C ? C.PROVIDER_BIBLEAPI : 'bible-api.com';

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
    // Open sources scrolled to the cited paragraph.
    scrollToSnippet: { def: true, norm: bool(true) },
    // Citation layout. One documented default, used by every context.
    citationView: { def: 'source', norm: oneOf(['source', 'verse'], 'source') },
    // Show the citation-layout sub-toggle in the panel.
    showCitationToggle: { def: true, norm: bool(true) },
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

  const KEY = C ? C.SETTINGS_KEY : 'btxSettings';
  const AREA = 'sync';

  let cache = null; // last known normalized settings for this context
  // The value subscribers were last told about. Tracked separately from
  // `cache` because a write updates the cache immediately (so a read right
  // after a write is correct) while the change event only arrives later — and
  // that event's "what changed" has to be measured against what subscribers
  // last saw, not against the value we just optimistically cached.
  let notified = null;
  const listeners = new Set();
  // Values this context has written but not yet seen echoed back through
  // storage.onChanged, so a subscriber can tell its own write from someone
  // else's. Bounded: a write whose echo never arrives must not leak.
  const pendingOwnWrites = [];
  const MAX_PENDING = 8;
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

  function writeRaw(value) {
    return new Promise((resolve) => {
      try {
        chrome.storage[AREA].set({ [KEY]: value }, () => {
          if (chrome.runtime) void chrome.runtime.lastError; // swallow
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  // True (and consumes the record) if `next` is the echo of a write we made.
  function claimOwnWrite(next) {
    const i = pendingOwnWrites.findIndex((w) => diff(w, next).length === 0);
    if (i === -1) return false;
    pendingOwnWrites.splice(i, 1);
    return true;
  }

  function wire() {
    if (wired || !hasStorage() || !chrome.storage.onChanged) return;
    wired = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== AREA || !changes[KEY]) return;
      const next = normalize(changes[KEY].newValue);
      const prev = notified || normalize(changes[KEY].oldValue);
      cache = next;
      notified = next;
      const changed = diff(prev, next);
      const own = claimOwnWrite(next);
      if (!changed.length) return; // a re-save of identical values is not a change
      for (const fn of Array.from(listeners)) {
        try { fn({ next, prev, changed, own }); } catch (e) { /* one bad listener shouldn't stop the rest */ }
      }
    });
  }

  // Current settings, normalized. Cached per context and kept fresh by the
  // onChanged listener, so callers can call this freely.
  async function get() {
    if (cache) return cache;
    wire();
    cache = hasStorage() ? normalize(await readRaw()) : defaults();
    if (!notified) notified = cache;
    return cache;
  }

  async function write(next) {
    wire();
    cache = next;
    pendingOwnWrites.push(next);
    while (pendingOwnWrites.length > MAX_PENDING) pendingOwnWrites.shift();
    if (hasStorage()) await writeRaw(next);
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
