import { Hono } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';
import { createLogger } from './logger.js';
import { seedScenarios } from './seed.js';
import { verifyAccessJwt } from './auth.js';

/**
 * @typedef {object} Env
 * @property {R2Bucket} MD_FILES
 * @property {KVNamespace} HISTORY
 * @property {Fetcher} ASSETS
 * @property {string} ACCESS_AUD          Access application AUD tag (wrangler var)
 * @property {string} ACCESS_TEAM_DOMAIN  e.g. myteam.cloudflareaccess.com (wrangler var)
 * @property {string} [LOG_LEVEL]
 * @property {string} [ENVIRONMENT]   'production' in wrangler.jsonc; 'uat' under env.uat
 * @property {string} [AUTH_STUB_USER] set only by scripts/uat.mjs via `wrangler dev --var`
 */

/** @typedef {{ id: string, email: string }} User */

/** @type {Hono<{ Bindings: Env, Variables: { logger: ReturnType<typeof createLogger>, user: User | null } }>} */
const app = new Hono();

// ── Per-user key helpers ────────────────────────────────────────────────────

const historyKey = (userId) => `history:${userId}`;
const foldersKey = (userId) => `folders:${userId}`;
const notesKey = (userId) => `user:${userId}:notes`;

async function readJsonArray(kv, key) {
  const data = await kv.get(key);
  if (!data) return [];
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── History helpers (per user) ──────────────────────────────────────────────

const HISTORY_MAX = 100;

async function readHistory(kv, userId) {
  return readJsonArray(kv, historyKey(userId));
}

async function writeHistory(kv, userId, history) {
  await kv.put(historyKey(userId), JSON.stringify(history));
}

async function addHistoryEntry(kv, userId, entry) {
  const now = new Date().toISOString();
  const history = await readHistory(kv, userId);
  const filtered = history.filter((h) => h.id !== entry.id);
  filtered.unshift({ ...entry, viewedAt: now });
  if (filtered.length > HISTORY_MAX) filtered.length = HISTORY_MAX;
  await writeHistory(kv, userId, filtered);
}

/** Refresh lastAccessedAt (authoritative timestamp for retention) and un-archive. */
async function touchMeta(kv, id) {
  const metaKey = `meta:${id}`;
  const metaJson = await kv.get(metaKey);
  if (!metaJson) return;
  try {
    const meta = JSON.parse(metaJson);
    meta.lastAccessedAt = new Date().toISOString();
    delete meta.archivedAt;
    await kv.put(metaKey, JSON.stringify(meta));
  } catch {
    /* leave metadata unchanged on parse error */
  }
}

// ── Owner note index ────────────────────────────────────────────────────────
// Authoritative list of a user's notes, newest first. Replaces prefix listing
// (kv.list is eventually consistent and can lag behind a fresh write).

async function readNoteIndex(kv, userId) {
  return readJsonArray(kv, notesKey(userId));
}

async function addToNoteIndex(kv, userId, id) {
  const ids = await readNoteIndex(kv, userId);
  await kv.put(notesKey(userId), JSON.stringify([id, ...ids.filter((x) => x !== id)]));
}

async function removeFromNoteIndex(kv, userId, id) {
  const ids = await readNoteIndex(kv, userId);
  if (!ids.includes(id)) return;
  await kv.put(notesKey(userId), JSON.stringify(ids.filter((x) => x !== id)));
}

/** Metadata for a freshly created note. */
function newMeta({ filename, source, size, ownerId }) {
  const now = new Date().toISOString();
  return {
    filename,
    source,
    size,
    created: now,
    lastAccessedAt: now,
    ownerId,
    visibility: 'private',
    editors: [],
    currentRev: 0,
  };
}

// ── Folder helpers ──────────────────────────────────────────────────────────

function generateFolderId() {
  return 'f-' + crypto.randomUUID().slice(0, 8);
}

async function readFolders(kv, userId) {
  return readJsonArray(kv, foldersKey(userId));
}

async function writeFolders(kv, userId, folders) {
  await kv.put(foldersKey(userId), JSON.stringify(folders));
}

// ── User helpers ────────────────────────────────────────────────────────────

const ACCESS_COOKIE = 'CF_Authorization';

/** Resolve the caller. Dev stub wins; otherwise verify the Access JWT. */
async function resolveUser(c) {
  if (isDevEnv(c.env)) {
    const id = c.req.header('x-dev-user') || c.env.AUTH_STUB_USER;
    return { id, email: `${id}@dev.local` };
  }
  const token = c.req.header('cf-access-jwt-assertion') || getCookie(c, ACCESS_COOKIE);
  return verifyAccessJwt(token, {
    aud: c.env.ACCESS_AUD,
    teamDomain: c.env.ACCESS_TEAM_DOMAIN,
  });
}

/** Create or touch `user:{id}`. */
async function upsertUser(kv, user) {
  const key = `user:${user.id}`;
  const now = new Date().toISOString();
  const existing = await kv.get(key);
  let record = { id: user.id, email: user.email, createdAt: now, lastSeenAt: now };
  if (existing) {
    try {
      record = { ...JSON.parse(existing), email: user.email, lastSeenAt: now };
    } catch {
      /* overwrite corrupt record */
    }
  }
  await kv.put(key, JSON.stringify(record));
  return record;
}

/** Only allow same-origin absolute paths as a post-login destination. */
function safeNext(raw) {
  if (!raw) return '/';
  let u;
  try {
    u = new URL(raw, 'http://x');
  } catch {
    return '/';
  }
  if (u.origin !== 'http://x' || !u.pathname.startsWith('/')) return '/';
  return u.pathname + u.search;
}

// ── KV metadata scan helper ─────────────────────────────────────────────────

async function listAllMeta(kv) {
  const result = new Map();
  let cursor;
  while (true) {
    const list = await kv.list({ prefix: 'meta:', cursor });
    for (const key of list.keys) {
      const metaJson = await kv.get(key.name);
      if (!metaJson) continue;
      try {
        result.set(key.name.slice(5), JSON.parse(metaJson));
      } catch {
        /* skip corrupt */
      }
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  return result;
}

// Direct per-id metadata lookup. Unlike listAllMeta(), this does not depend on
// kv.list(), which is eventually consistent and can lag behind a fresh write.
// Used by the sidebar routes so a newly created note appears immediately.
async function getMetaMany(kv, ids) {
  const unique = [...new Set(ids)];
  const values = await Promise.all(unique.map((id) => kv.get(`meta:${id}`)));
  const result = new Map();
  unique.forEach((id, i) => {
    if (!values[i]) return;
    try {
      result.set(id, JSON.parse(values[i]));
    } catch {
      /* skip corrupt */
    }
  });
  return result;
}

// ── Retention cron handler ──────────────────────────────────────────────────
// Runs daily at 03:00 UTC. Archives after 30 days of inactivity, deletes after 60.

const ARCHIVE_MS = 30 * 24 * 60 * 60 * 1000;
const DELETE_MS = 60 * 24 * 60 * 60 * 1000;

async function runRetention(env, log) {
  const now = Date.now();
  const allMeta = await listAllMeta(env.HISTORY);
  const foldersByOwner = new Map();
  async function ownerFolderIds(ownerId) {
    if (!ownerId) return new Set();
    if (!foldersByOwner.has(ownerId)) {
      const f = await readFolders(env.HISTORY, ownerId);
      foldersByOwner.set(ownerId, new Set(f.map((x) => x.id)));
    }
    return foldersByOwner.get(ownerId);
  }
  const deletedIds = [];
  /** @type {Map<string, string[]>} */
  const deletedByOwner = new Map();
  let archivedCount = 0;

  for (const [id, meta] of allMeta) {
    const ref = meta.lastAccessedAt || meta.created;
    if (!ref) continue;

    const folderIds = await ownerFolderIds(meta.ownerId);

    // Skip files in valid folders (exempt from retention)
    if (meta.folderId && folderIds.has(meta.folderId)) continue;

    // Clear stale folder references
    if (meta.folderId && !folderIds.has(meta.folderId)) {
      delete meta.folderId;
      await env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));
    }

    const age = now - new Date(ref).getTime();

    if (age >= DELETE_MS) {
      await env.HISTORY.delete(`meta:${id}`);
      await env.MD_FILES.delete(`${id}.md`);
      deletedIds.push(id);
      if (meta.ownerId) {
        if (!deletedByOwner.has(meta.ownerId)) deletedByOwner.set(meta.ownerId, []);
        deletedByOwner.get(meta.ownerId).push(id);
      }
    } else if (age >= ARCHIVE_MS && !meta.archivedAt) {
      meta.archivedAt = new Date().toISOString();
      await env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));
      archivedCount++;
    }
  }

  for (const [ownerId, ids] of deletedByOwner) {
    const deleted = new Set(ids);
    const history = await readHistory(env.HISTORY, ownerId);
    await writeHistory(
      env.HISTORY,
      ownerId,
      history.filter((h) => !deleted.has(h.id))
    );
    for (const id of ids) await removeFromNoteIndex(env.HISTORY, ownerId, id);
  }

  log.info('retention.run', { archived: archivedCount, deleted: deletedIds.length });
}

// ── Logging middleware ───────────────────────────────────────────────────

app.use('/api/*', async (c, next) => {
  const log = createLogger(c.env.LOG_LEVEL);
  c.set('logger', log);
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const status = c.res.status;
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  const lvl = status === 401 ? 'warn' : 'info';
  log[lvl]('request', { method, path, status, duration });
});

// ── Dev / UAT gate ──────────────────────────────────────────────────────────
// Two independent conditions: a stub user must be injected (only scripts/uat.mjs
// does this, via `wrangler dev --var`) AND the deployment must not be production.
// Covered by src/dev.integration.test.js — keep those tests green.

function isDevEnv(env) {
  return Boolean(env.AUTH_STUB_USER) && env.ENVIRONMENT !== 'production';
}

// /api/dev/* is invisible (404) outside UAT, evaluated before auth so the
// response is identical to any other unknown route.
app.use('/api/dev/*', async (c, next) => {
  if (!isDevEnv(c.env)) return c.notFound();
  return next();
});

// ── Auth middleware ──────────────────────────────────────────────────────────
// Resolves the caller on every /api/* request (dev stub → Access JWT → null).
// Only /api/auth/* is reachable anonymously; everything else 401s without a user.

app.use('/api/*', async (c, next) => {
  const user = await resolveUser(c);
  c.set('user', user);
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/auth/')) return next();
  if (!user) {
    c.get('logger').warn('auth.unauthorized', { path });
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

// ── Auth routes ─────────────────────────────────────────────────────────────
// /api/auth/login is the only path gated by Cloudflare Access. Access
// authenticates, sets CF_Authorization on this domain, then forwards here.

app.get('/api/auth/login', async (c) => {
  const user = c.get('user');
  const next = safeNext(c.req.query('next'));
  if (!user) {
    c.get('logger').warn('auth.login_without_token');
    return c.redirect('/', 302);
  }
  await upsertUser(c.env.HISTORY, user);
  c.get('logger').info('auth.login', { userId: user.id });
  return c.redirect(next, 302);
});

app.post('/api/auth/logout', (c) => {
  deleteCookie(c, ACCESS_COOKIE, { path: '/' });
  c.get('logger').info('auth.logout');
  return c.json({ redirect: '/cdn-cgi/access/logout' });
});

app.get('/api/auth/check', (c) => {
  const user = c.get('user');
  const body = { authenticated: Boolean(user), user };
  if (isDevEnv(c.env)) return c.json({ ...body, stub: c.env.AUTH_STUB_USER });
  return c.json(body);
});

// ── Dev routes (UAT only) ───────────────────────────────────────────────────

app.post('/api/dev/seed', async (c) => {
  const counts = await seedScenarios(c.env);
  c.get('logger').info('dev.seed', counts);
  return c.json({ ok: true, ...counts });
});

app.post('/api/dev/retention', async (c) => {
  await runRetention(c.env, c.get('logger'));
  return c.json({ ok: true });
});

// ── File upload ─────────────────────────────────────────────────────────────

app.post('/api/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400);
  }

  const originalName = file.name || 'untitled.md';
  if (!originalName.toLowerCase().endsWith('.md')) {
    return c.json({ error: 'Only .md files are accepted' }, 400);
  }

  const user = c.get('user');
  const id = crypto.randomUUID();
  const content = await file.text();
  const meta = newMeta({
    filename: originalName,
    source: 'upload',
    size: content.length,
    ownerId: user.id,
  });

  await c.env.MD_FILES.put(`${id}.md`, content);
  await c.env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));
  await addToNoteIndex(c.env.HISTORY, user.id, id);
  await addHistoryEntry(c.env.HISTORY, user.id, { id, filename: originalName, source: 'upload' });

  c.get('logger').info('file.upload', { fileId: id, filename: originalName, size: content.length });
  return c.json({ id, filename: originalName });
});

// ── Paste upload ────────────────────────────────────────────────────────────

app.post('/api/paste', async (c) => {
  const { content, title } = await c.req.json();
  if (!content || typeof content !== 'string') {
    return c.json({ error: 'No content provided' }, 400);
  }

  const user = c.get('user');
  const id = crypto.randomUUID();
  const displayName = title || 'Pasted Markdown';
  const meta = newMeta({
    filename: displayName,
    source: 'paste',
    size: content.length,
    ownerId: user.id,
  });

  await c.env.MD_FILES.put(`${id}.md`, content);
  await c.env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));
  await addToNoteIndex(c.env.HISTORY, user.id, id);
  await addHistoryEntry(c.env.HISTORY, user.id, { id, filename: displayName, source: 'paste' });

  c.get('logger').info('file.paste', { fileId: id, filename: displayName, size: content.length });
  return c.json({ id, filename: displayName });
});

// ── File listing ────────────────────────────────────────────────────────────

app.get('/api/files', async (c) => {
  const user = c.get('user');
  const ids = await readNoteIndex(c.env.HISTORY, user.id);
  const allMeta = await getMetaMany(c.env.HISTORY, ids);
  const files = [];
  for (const id of ids) {
    const meta = allMeta.get(id);
    if (!meta || meta.archivedAt) continue;
    files.push({
      id,
      filename: meta.filename,
      displayName: meta.filename,
      source: meta.source,
      size: meta.size,
      visibility: meta.visibility || 'private',
      modified: meta.lastAccessedAt || meta.created,
    });
  }
  return c.json(files);
});

// ── File content ────────────────────────────────────────────────────────────

app.get('/api/files/:id', async (c) => {
  const id = c.req.param('id');

  const object = await c.env.MD_FILES.get(`${id}.md`);
  if (!object) {
    const log = c.get('logger');
    log.warn('file.notFound', { fileId: id });
    return c.json({ error: 'File not found' }, 404);
  }

  const content = await object.text();

  // Get display name from metadata
  const metaJson = await c.env.HISTORY.get(`meta:${id}`);
  let displayName = `${id}.md`;
  let source = 'upload';
  let created = null;
  if (metaJson) {
    try {
      const meta = JSON.parse(metaJson);
      displayName = meta.filename || displayName;
      source = meta.source || source;
      created = meta.created || null;
    } catch {
      /* use defaults */
    }
  }

  await touchMeta(c.env.HISTORY, id);
  await addHistoryEntry(c.env.HISTORY, c.get('user').id, { id, filename: displayName, source });

  const log = c.get('logger');
  log.debug('file.fetch', { fileId: id });

  return c.json({ id, filename: displayName, content, created });
});

// ── File rename ─────────────────────────────────────────────────────────────

app.patch('/api/files/:id', async (c) => {
  const id = c.req.param('id');
  const { filename } = await c.req.json();

  if (!filename || !filename.trim()) {
    return c.json({ error: 'Filename is required' }, 400);
  }

  const trimmed = filename.trim();

  const metaJson = await c.env.HISTORY.get(`meta:${id}`);
  if (!metaJson) {
    const log = c.get('logger');
    log.warn('file.notFound', { fileId: id });
    return c.json({ error: 'File not found' }, 404);
  }

  const meta = JSON.parse(metaJson);
  meta.filename = trimmed;
  await c.env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));

  const history = await readHistory(c.env.HISTORY, c.get('user').id);
  const updated = history.map((h) => (h.id === id ? { ...h, filename: trimmed } : h));
  await writeHistory(c.env.HISTORY, c.get('user').id, updated);

  const log = c.get('logger');
  log.info('file.rename', { fileId: id, filename: trimmed });

  return c.json({ id, filename: trimmed });
});

// ── File delete ─────────────────────────────────────────────────────────────

app.delete('/api/files/:id', async (c) => {
  const id = c.req.param('id');

  await c.env.MD_FILES.delete(`${id}.md`);
  await c.env.HISTORY.delete(`meta:${id}`);

  const history = await readHistory(c.env.HISTORY, c.get('user').id);
  await writeHistory(
    c.env.HISTORY,
    c.get('user').id,
    history.filter((h) => h.id !== id)
  );

  const folders = await readFolders(c.env.HISTORY, c.get('user').id);
  let foldersChanged = false;
  for (const folder of folders) {
    const before = folder.fileIds.length;
    folder.fileIds = folder.fileIds.filter((fid) => fid !== id);
    if (folder.fileIds.length !== before) foldersChanged = true;
  }
  if (foldersChanged) await writeFolders(c.env.HISTORY, c.get('user').id, folders);

  const log = c.get('logger');
  log.info('file.delete', { fileId: id });

  return c.json({ success: true });
});

// ── History routes ──────────────────────────────────────────────────────────

app.get('/api/history', async (c) => {
  const history = await readHistory(c.env.HISTORY, c.get('user').id);
  const allMeta = await getMetaMany(
    c.env.HISTORY,
    history.map((h) => h.id)
  );

  return c.json(
    history
      .filter((h) => {
        const meta = allMeta.get(h.id);
        return meta && !meta.archivedAt;
      })
      .map((h) => {
        const meta = allMeta.get(h.id);
        return { ...h, folderId: meta?.folderId || null };
      })
  );
});

app.delete('/api/history', async (c) => {
  await writeHistory(c.env.HISTORY, c.get('user').id, []);
  const log = c.get('logger');
  log.info('history.clear');
  return c.json({ success: true });
});

app.delete('/api/history/:id', async (c) => {
  const id = c.req.param('id');
  const history = await readHistory(c.env.HISTORY, c.get('user').id);
  await writeHistory(
    c.env.HISTORY,
    c.get('user').id,
    history.filter((h) => h.id !== id)
  );
  const log = c.get('logger');
  log.info('history.remove', { entryId: id });
  return c.json({ success: true });
});

// ── Folder routes ───────────────────────────────────────────────────────────

app.get('/api/folders', async (c) => {
  const folders = await readFolders(c.env.HISTORY, c.get('user').id);
  const allMeta = await getMetaMany(
    c.env.HISTORY,
    folders.flatMap((f) => f.fileIds)
  );

  const enriched = folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    created: folder.created,
    files: folder.fileIds
      .map((fid) => {
        const meta = allMeta.get(fid);
        if (!meta) return null;
        return { id: fid, filename: meta.filename, source: meta.source, size: meta.size };
      })
      .filter(Boolean),
  }));

  return c.json(enriched);
});

app.post('/api/folders', async (c) => {
  const { name } = await c.req.json();
  if (!name || !name.trim()) {
    return c.json({ error: 'Folder name is required' }, 400);
  }

  const folder = {
    id: generateFolderId(),
    name: name.trim(),
    fileIds: [],
    created: new Date().toISOString(),
  };

  const folders = await readFolders(c.env.HISTORY, c.get('user').id);
  folders.push(folder);
  await writeFolders(c.env.HISTORY, c.get('user').id, folders);

  const log = c.get('logger');
  log.info('folder.create', { folderId: folder.id, name: folder.name });

  return c.json(folder, 201);
});

app.patch('/api/folders/:id', async (c) => {
  const id = c.req.param('id');
  const { name } = await c.req.json();
  if (!name || !name.trim()) {
    return c.json({ error: 'Folder name is required' }, 400);
  }

  const folders = await readFolders(c.env.HISTORY, c.get('user').id);
  const folder = folders.find((f) => f.id === id);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  folder.name = name.trim();
  await writeFolders(c.env.HISTORY, c.get('user').id, folders);

  return c.json(folder);
});

app.delete('/api/folders/:id', async (c) => {
  const id = c.req.param('id');
  const folders = await readFolders(c.env.HISTORY, c.get('user').id);
  const folder = folders.find((f) => f.id === id);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  for (const fid of folder.fileIds) {
    await c.env.MD_FILES.delete(`${fid}.md`);
    await c.env.HISTORY.delete(`meta:${fid}`);
  }

  if (folder.fileIds.length > 0) {
    const deleted = new Set(folder.fileIds);
    const history = await readHistory(c.env.HISTORY, c.get('user').id);
    await writeHistory(
      c.env.HISTORY,
      c.get('user').id,
      history.filter((h) => !deleted.has(h.id))
    );
  }

  await writeFolders(
    c.env.HISTORY,
    c.get('user').id,
    folders.filter((f) => f.id !== id)
  );

  const log = c.get('logger');
  log.info('folder.delete', { folderId: id, fileCount: folder.fileIds.length });

  return c.json({ success: true });
});

app.post('/api/folders/:id/files', async (c) => {
  const folderId = c.req.param('id');
  const { fileId } = await c.req.json();
  if (!fileId) return c.json({ error: 'fileId is required' }, 400);

  const folders = await readFolders(c.env.HISTORY, c.get('user').id);
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  const metaJson = await c.env.HISTORY.get(`meta:${fileId}`);
  if (!metaJson) return c.json({ error: 'File not found' }, 404);

  for (const f of folders) {
    f.fileIds = f.fileIds.filter((id) => id !== fileId);
  }

  folder.fileIds.push(fileId);
  await writeFolders(c.env.HISTORY, c.get('user').id, folders);

  const meta = JSON.parse(metaJson);
  meta.folderId = folderId;
  await c.env.HISTORY.put(`meta:${fileId}`, JSON.stringify(meta));

  return c.json({ success: true });
});

app.delete('/api/folders/:id/files/:fileId', async (c) => {
  const folderId = c.req.param('id');
  const fileId = c.req.param('fileId');

  const folders = await readFolders(c.env.HISTORY, c.get('user').id);
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  folder.fileIds = folder.fileIds.filter((id) => id !== fileId);
  await writeFolders(c.env.HISTORY, c.get('user').id, folders);

  const metaJson = await c.env.HISTORY.get(`meta:${fileId}`);
  if (metaJson) {
    try {
      const meta = JSON.parse(metaJson);
      delete meta.folderId;
      await c.env.HISTORY.put(`meta:${fileId}`, JSON.stringify(meta));
    } catch {
      /* ignore corrupt meta */
    }
  }

  return c.json({ success: true });
});

app.post('/api/folders/:id/files/:fileId/move', async (c) => {
  const sourceFolderId = c.req.param('id');
  const fileId = c.req.param('fileId');
  const { targetFolderId } = await c.req.json();
  if (!targetFolderId) return c.json({ error: 'targetFolderId is required' }, 400);

  const folders = await readFolders(c.env.HISTORY, c.get('user').id);
  const source = folders.find((f) => f.id === sourceFolderId);
  const target = folders.find((f) => f.id === targetFolderId);
  if (!source || !target) return c.json({ error: 'Folder not found' }, 404);

  source.fileIds = source.fileIds.filter((id) => id !== fileId);
  if (!target.fileIds.includes(fileId)) target.fileIds.push(fileId);
  await writeFolders(c.env.HISTORY, c.get('user').id, folders);

  const metaJson = await c.env.HISTORY.get(`meta:${fileId}`);
  if (metaJson) {
    try {
      const meta = JSON.parse(metaJson);
      meta.folderId = targetFolderId;
      await c.env.HISTORY.put(`meta:${fileId}`, JSON.stringify(meta));
    } catch {
      /* ignore corrupt meta */
    }
  }

  return c.json({ success: true });
});

// ── SPA fallback ────────────────────────────────────────────────────────────
// Serve index.html for note paths so direct links & browser refresh work.
// Note URLs are base36-encoded UUIDs (25 chars, [0-9a-z]); legacy full-UUID
// URLs are also accepted. The client decodes the path back to the UUID.

const UUID_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^\/[0-9a-z]{25}$/i;
const UUID_LIMIT = 1n << 128n;

function isValidShortId(path) {
  if (!SHORT_ID_RE.test(path)) return false;
  let n = 0n;
  for (const ch of path.slice(1).toLowerCase()) {
    n = n * 36n + BigInt(parseInt(ch, 36));
  }
  return n < UUID_LIMIT;
}

app.get('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  if (UUID_RE.test(path) || isValidShortId(path)) {
    const url = new URL(c.req.url);
    url.pathname = '/';
    return c.env.ASSETS.fetch(new Request(url, c.req.raw));
  }
  return c.notFound();
});

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    const log = createLogger(env.LOG_LEVEL);
    ctx.waitUntil(
      runRetention(env, log).catch((err) => {
        log.error('retention.error', { error: err.message });
      })
    );
  },
};
