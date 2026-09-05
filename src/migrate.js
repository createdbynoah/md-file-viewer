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
 * Any error thrown by the kv adapter propagates: a failed read must abort the
 * run rather than be mistaken for an absent key, because the legacy singleton
 * keys are deleted right after their per-user counterpart is written.
 *
 * @param {{ list: Function, get: Function, put: Function, delete: Function }} kv
 * @param {string} ownerId  the operator's Access `sub`
 * @param {{ log?: (msg: string, data?: object) => void }} [opts]
 */
export async function migrateToOwner(kv, ownerId, { log = () => {} } = {}) {
  if (!ownerId) throw new Error('ownerId is required');
  const result = {
    stamped: 0,
    skipped: 0,
    missing: 0,
    indexed: 0,
    movedHistory: false,
    movedFolders: false,
  };

  // 1. Stamp legacy meta. `owned` collects EVERY note that belongs to ownerId
  // once this pass is done — stamped just now or stamped by an earlier,
  // interrupted run — so step 2 can rebuild the index from scratch and heal a
  // run that died between stamping and writing the index.
  const owned = []; // { id, created }
  for (const key of await listKeys(kv, 'meta:')) {
    const id = key.slice(5);
    const raw = await kv.get(key);
    if (!raw) {
      result.missing++;
      log('skip missing meta', { id });
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(raw);
    } catch {
      log('skip corrupt meta', { id });
      continue;
    }
    if (meta.ownerId) {
      result.skipped++;
      if (meta.ownerId === ownerId) owned.push({ id, created: meta.created || '' });
      continue;
    }
    meta.ownerId = ownerId;
    meta.visibility = 'link';
    meta.editors = [];
    meta.currentRev = 0;
    await kv.put(key, JSON.stringify(meta));
    owned.push({ id, created: meta.created || '' });
    result.stamped++;
    log('stamped', { id });
  }

  // 2. Owner index: existing order first, then every other owned id
  // newest-created first. `indexed` counts only the ids newly added.
  if (owned.length) {
    const indexKey = `user:${ownerId}:notes`;
    const existing = (await readArray(kv, indexKey)) || [];
    const have = new Set(existing);
    owned.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
    const added = owned.map((s) => s.id).filter((id) => !have.has(id));
    if (added.length) {
      await kv.put(indexKey, JSON.stringify([...existing, ...added]));
      result.indexed = added.length;
    }
  }

  // 3. Legacy history → history:{owner} (existing per-user entries stay first).
  const legacyHistory = await readArray(kv, 'history');
  if (legacyHistory) {
    const key = `history:${ownerId}`;
    const current = (await readArray(kv, key)) || [];
    const seen = new Set(current.map((h) => h.id));
    const combined = [...current, ...legacyHistory.filter((h) => h && !seen.has(h.id))];
    const merged = combined.slice(0, HISTORY_MAX);
    if (combined.length > merged.length) {
      log(
        `history: dropped ${combined.length - merged.length} legacy entries (cap ${HISTORY_MAX})`
      );
    }
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
