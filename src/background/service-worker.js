/*
 * Background service worker: message router between content scripts / options
 * page and the network + cache + rate-limit layers.
 *
 * Classic (non-module) worker so a single IIFE authoring style works everywhere;
 * dependencies are pulled in with importScripts in dependency order.
 */
'use strict';

importScripts(
  '../shared/constants.js',
  '../shared/settings.js',
  '../shared/books.js',
  './cache.js',
  './ratelimit.js',
  './api.js'
);

const C = self.__BTX.const;
const SETTINGS = self.__BTX.settings;
const API = self.__BTX.api;
const CACHE = self.__BTX.cache;
const RATE = self.__BTX.rate;

// Settings (schema, normalization, caching, invalidation) are owned by
// __BTX.settings — this worker is just one of its adapters.

// ---- Handlers ----
async function handleGetEnabledTranslations() {
  const s = await SETTINGS.get();
  return {
    translations: s.enabledTranslations,
    defaultId: s.defaultTranslationId,
    provider: s.provider,
    hasKey: !!s.apiKey,
    actOnNonEngOnly: s.actOnNonEngOnly,
  };
}

async function handleListBibles(msg) {
  // Used by the options page to test a key before saving. Prefer the key from
  // the message (the one being tested); fall back to the stored key.
  const s = await SETTINGS.get();
  const key = msg.key || s.apiKey;
  const cached = !msg.key ? await CACHE.getBibles() : null;
  if (cached) return { bibles: cached };
  const result = await API.listBibles(key);
  if (!result.error && result.bibles) await CACHE.setBibles(result.bibles);
  return result;
}

async function handleGetChapter(msg) {
  const { provider, bibleId, chapterId, ldsBook, chapter } = msg;
  if (!provider || !bibleId || !chapterId) return { error: { code: C.ERR.UNKNOWN, message: 'Bad request' } };

  // Cache first (does not count against rate limits).
  const cached = await CACHE.getChapter(provider, bibleId, chapterId);
  if (cached) return cached;

  const s = await SETTINGS.get();

  let result;
  if (provider === C.PROVIDER_BIBLEAPI) {
    result = await API.fetchBibleApiChapter(bibleId, ldsBook, chapter);
  } else {
    if (!s.apiKey) return { error: { code: C.ERR.NO_KEY, message: 'No API key set' } };
    const gate = await RATE.check();
    if (!gate.ok) {
      return { error: { code: C.ERR.RATE_LIMITED, message: gate.reason, retryAfterMs: gate.retryAfterMs } };
    }
    result = await API.fetchApiBibleChapter(s.apiKey, bibleId, chapterId);
    await RATE.consume();
  }

  if (result.error) return result;
  await CACHE.setChapter(provider, bibleId, chapterId, result.payload);
  // Forward FUMS only on a fresh fetch (cache hits return above without it).
  return Object.assign({}, result.payload, { fums: result.fums || null });
}

// ---- Message router ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  let promise;
  switch (msg.type) {
    case C.MSG.GET_ENABLED_TRANSLATIONS:
      promise = handleGetEnabledTranslations();
      break;
    case C.MSG.GET_CHAPTER:
      promise = handleGetChapter(msg);
      break;
    case C.MSG.LIST_BIBLES:
      promise = handleListBibles(msg);
      break;
    case C.MSG.OPEN_OPTIONS:
      chrome.runtime.openOptionsPage();
      promise = Promise.resolve({ ok: true });
      break;
    default:
      return false;
  }
  promise
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ error: { code: C.ERR.UNKNOWN, message: String(e) } }));
  return true; // async response
});

// ---- Toolbar icon toggles the panel on the active tab ----
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: C.MSG.TOGGLE_PANEL }).catch(() => {});
  }
});
