// Per-note scroll position memory. Positions are stored as a ratio of the
// scrollable range rather than pixels so they survive rotation and
// desktop/mobile width changes. Storage is any localStorage-like object.

export const SCROLL_KEY_PREFIX = 'scrollPos:';
export const SCROLL_MAX_ENTRIES = 50;
// Positions this close to the top are not worth restoring.
const MIN_RESTORE_RATIO = 0.02;

export function scrollRatio({ scrollTop, scrollHeight, clientHeight }) {
  const range = scrollHeight - clientHeight;
  if (range <= 0) return 0;
  return Math.min(1, Math.max(0, scrollTop / range));
}

export function ratioToScrollTop(ratio, { scrollHeight, clientHeight }) {
  return Math.round(ratio * Math.max(0, scrollHeight - clientHeight));
}

export function saveScrollRatio(storage, id, ratio, now = Date.now()) {
  try {
    storage.setItem(SCROLL_KEY_PREFIX + id, JSON.stringify({ ratio, at: now }));
    prune(storage);
  } catch {}
}

export function loadScrollRatio(storage, id) {
  try {
    const raw = storage.getItem(SCROLL_KEY_PREFIX + id);
    if (!raw) return null;
    const { ratio } = JSON.parse(raw);
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
    return ratio < MIN_RESTORE_RATIO ? null : ratio;
  } catch {
    return null;
  }
}

function prune(storage) {
  const entries = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith(SCROLL_KEY_PREFIX)) continue;
    let at = 0;
    try {
      at = JSON.parse(storage.getItem(key)).at || 0;
    } catch {}
    entries.push({ key, at });
  }
  if (entries.length <= SCROLL_MAX_ENTRIES) return;
  entries.sort((a, b) => a.at - b.at);
  for (const { key } of entries.slice(0, entries.length - SCROLL_MAX_ENTRIES)) {
    storage.removeItem(key);
  }
}
