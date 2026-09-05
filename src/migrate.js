// One-shot migration from the single-owner layout (global `history`/`folders`,
// meta without ownerId) to the per-user layout. Idempotent. Runs against any
// object with the KVNamespace subset { list, get, put, delete } — the real
// binding in tests, a `wrangler kv` adapter in scripts/migrate-owner.mjs.

const HISTORY_MAX = 100;

async function readArray(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function listKeys(kv, prefix) {
  const names = [];
  let cursor;
  for (;;) {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) names.push(k.name);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return names;
}

/**
 * @param {{ list: Function, get: Function, put: Function, delete: Function }} kv
 * @param {string} ownerId  the operator's Access `sub`
 * @param {{ log?: (msg: string, data?: object) => void }} [opts]
 */
export async function migrateToOwner(kv, ownerId, { log = () => {} } = {}) {
  if (!ownerId) throw new Error('ownerId is required');
  const result = { stamped: 0, skipped: 0, indexed: 0, movedHistory: false, movedFolders: false };

  // 1. Stamp legacy meta.
  const stamped = []; // { id, created }
  for (const key of await listKeys(kv, 'meta:')) {
    const id = key.slice(5);
    const raw = await kv.get(key);
    if (!raw) continue;
    let meta;
    try {
      meta = JSON.parse(raw);
    } catch {
      log('skip corrupt meta', { id });
      continue;
    }
    if (meta.ownerId) {
      result.skipped++;
      continue;
    }
    meta.ownerId = ownerId;
    meta.visibility = 'link';
    meta.editors = [];
    meta.currentRev = 0;
    await kv.put(key, JSON.stringify(meta));
    stamped.push({ id, created: meta.created || '' });
    result.stamped++;
    log('stamped', { id });
  }

  // 2. Owner index: existing first, then stamped ids newest-created first.
  if (stamped.length) {
    const indexKey = `user:${ownerId}:notes`;
    const existing = (await readArray(kv, indexKey)) || [];
    const have = new Set(existing);
    stamped.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
    const added = stamped.map((s) => s.id).filter((id) => !have.has(id));
    await kv.put(indexKey, JSON.stringify([...existing, ...added]));
    result.indexed = added.length;
  }

  // 3. Legacy history → history:{owner} (existing per-user entries stay first).
  const legacyHistory = await readArray(kv, 'history');
  if (legacyHistory) {
    const key = `history:${ownerId}`;
    const current = (await readArray(kv, key)) || [];
    const seen = new Set(current.map((h) => h.id));
    const merged = [...current, ...legacyHistory.filter((h) => h && !seen.has(h.id))].slice(
      0,
      HISTORY_MAX
    );
    await kv.put(key, JSON.stringify(merged));
    await kv.delete('history');
    result.movedHistory = true;
  }

  // 4. Legacy folders → folders:{owner}.
  const legacyFolders = await readArray(kv, 'folders');
  if (legacyFolders) {
    const key = `folders:${ownerId}`;
    const current = (await readArray(kv, key)) || [];
    const ids = new Set(current.map((f) => f.id));
    await kv.put(
      key,
      JSON.stringify([...current, ...legacyFolders.filter((f) => f && !ids.has(f.id))])
    );
    await kv.delete('folders');
    result.movedFolders = true;
  }

  return result;
}
