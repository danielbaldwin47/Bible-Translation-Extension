/*
 * Rate limiting for api.bible: a 15-requests / 30s rolling window plus a
 * 5000 / day counter. Both are persisted to chrome.storage.local and rebuilt on
 * worker wake (MV3 service workers are killed frequently, so in-memory-only
 * state would be lost). Cache hits do NOT call these — only real network calls.
 *
 * Loaded via importScripts -> self.__BTX.rate.
 */
(function (root) {
  'use strict';

  const C = root.__BTX.const;

  function localGet(keys) {
    return chrome.storage.local.get(keys);
  }
  function localSet(obj) {
    return chrome.storage.local.set(obj);
  }

  function todayKey() {
    return C.RATE_DAILY_PREFIX + new Date().toISOString().slice(0, 10);
  }

  // Returns { ok: true } if a network call is allowed, else
  // { ok: false, retryAfterMs, reason }. Does not consume; call consume() after.
  async function check() {
    const now = Date.now();
    const data = await localGet([C.RATE_RECENT_KEY, todayKey()]);

    const recent = (Array.isArray(data[C.RATE_RECENT_KEY]) ? data[C.RATE_RECENT_KEY] : [])
      .filter((t) => now - t < C.RATE_WINDOW_MS);

    if (recent.length >= C.RATE_WINDOW_MAX) {
      const oldest = Math.min.apply(null, recent);
      return { ok: false, reason: 'window', retryAfterMs: C.RATE_WINDOW_MS - (now - oldest) + 50 };
    }

    const daily = typeof data[todayKey()] === 'number' ? data[todayKey()] : 0;
    if (daily >= C.RATE_DAILY_MAX) {
      // Retry tomorrow.
      const msUntilMidnight = new Date().setHours(24, 0, 0, 0) - now;
      return { ok: false, reason: 'daily', retryAfterMs: msUntilMidnight };
    }

    return { ok: true };
  }

  // Records one real network call against both counters.
  async function consume() {
    const now = Date.now();
    const tk = todayKey();
    const data = await localGet([C.RATE_RECENT_KEY, tk]);
    const recent = (Array.isArray(data[C.RATE_RECENT_KEY]) ? data[C.RATE_RECENT_KEY] : [])
      .filter((t) => now - t < C.RATE_WINDOW_MS);
    recent.push(now);
    const daily = (typeof data[tk] === 'number' ? data[tk] : 0) + 1;
    await localSet({ [C.RATE_RECENT_KEY]: recent, [tk]: daily });
  }

  root.__BTX.rate = { check, consume };
})(self);
