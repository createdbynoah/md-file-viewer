import { Hono } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';
import { createLogger } from './logger.js';
import { seedScenarios } from './seed.js';
import { verifyAccessJwt } from './auth.js';
import { locate } from '../public/js/anchor.js';

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
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const REVISIONS_MAX = 100;
const MESSAGE_MAX = 200;

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

const TOUCH_THROTTLE_MS = 60 * 60 * 1000;

/**
 * Refresh lastAccessedAt (authoritative timestamp for retention) and un-archive.
 * Throttled: a meta touched within the last hour and not archived is left alone,
 * so a read never writes back a copy of a meta that may already be stale.
 */
async function touchMeta(kv, id) {
  const metaKey = `meta:${id}`;
  const metaJson = await kv.get(metaKey);
  if (!metaJson) return;
  try {
    const meta = JSON.parse(metaJson);
    const last = Date.parse(meta.lastAccessedAt);
    if (!meta.archivedAt && Number.isFinite(last) && Date.now() - last < TOUCH_THROTTLE_MS) return;
    meta.lastAccessedAt = new Date().toISOString();
    delete meta.archivedAt;
    await kv.put(metaKey, JSON.stringify(meta));
  } catch {
    /* leave metadata unchanged on parse error */
  }
}

// ── Revisions ───────────────────────────────────────────────────────────────
// rev:{uuid} = [{ n, at, by, message, bytes }] newest first, cap REVISIONS_MAX.
// Snapshot n lives at R2 `{uuid}/r/{n}.md`; `{uuid}.md` is always the latest.

const revKey = (id) => `rev:${id}`;
const snapshotKey = (id, n) => `${id}/r/${n}.md`;
const commentsKey = (id) => `comments:${id}`;

async function readRevisions(kv, id) {
  return readJsonArray(kv, revKey(id));
}

/** Remove a note's current object, every snapshot, and its revision log. */
async function deleteNoteObjects(env, id) {
  await env.MD_FILES.delete(`${id}.md`);
  let cursor;
  while (true) {
    const page = await env.MD_FILES.list({ prefix: `${id}/r/`, cursor });
    if (page.objects.length) await env.MD_FILES.delete(page.objects.map((o) => o.key));
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  await env.HISTORY.delete(revKey(id));
  await env.HISTORY.delete(commentsKey(id));
}

function cleanMessage(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MESSAGE_MAX);
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

// ── Ownership / visibility ──────────────────────────────────────────────────

async function loadMeta(kv, id) {
  const raw = await kv.get(`meta:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isOwner(meta, user) {
  return Boolean(user && meta.ownerId && meta.ownerId === user.id);
}

/**
 * link → anyone. private → owner. Legacy meta (no ownerId, pre-migration) →
 * any authenticated user. Never anonymous on private/legacy.
 */
function canRead(meta, user) {
  if (meta.visibility === 'link') return true;
  if (!user) return false;
  if (!meta.ownerId) return true;
  return meta.ownerId === user.id;
}

const PUBLIC_READ_RE = /^\/api\/files\/[^/]+(\/revisions(\/[^/]+)?)?$/;

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

    // Legacy notes without an owner are untouched until the owner migration
    // stamps them — skip before any folderId stripping, archiving, or deletion.
    if (!meta.ownerId) continue;

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
      await deleteNoteObjects(env, id);
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
// /api/auth/* and GET /api/files/:id are reachable anonymously (the latter
// enforces visibility itself); everything else 401s without a user.

app.use('/api/*', async (c, next) => {
  const user = await resolveUser(c);
  c.set('user', user);
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/auth/')) return next();
  // Note reads are visibility-checked in the handler (link notes are public).
  if (c.req.method === 'GET' && PUBLIC_READ_RE.test(path)) return next();
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
  if (content.length > MAX_NOTE_BYTES) {
    return c.json({ error: 'Note too large (max 2 MB)' }, 400);
  }
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
  if (content.length > MAX_NOTE_BYTES) {
    return c.json({ error: 'Note too large (max 2 MB)' }, 400);
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
  const user = c.get('user');
  const log = c.get('logger');

  const meta = await loadMeta(c.env.HISTORY, id);
  if (!meta || !canRead(meta, user)) {
    log.warn('file.notFound', { fileId: id });
    return c.json({ error: 'File not found' }, 404);
  }
  const object = await c.env.MD_FILES.get(`${id}.md`);
  if (!object) {
    log.warn('file.notFound', { fileId: id });
    return c.json({ error: 'File not found' }, 404);
  }
  const content = await object.text();
  const displayName = meta.filename || `${id}.md`;

  // Owner-only: a non-owner read must never rewrite meta (a stale read-back
  // could undo a just-made visibility change under KV eventual consistency).
  if (isOwner(meta, user)) await touchMeta(c.env.HISTORY, id);
  if (user) {
    await addHistoryEntry(c.env.HISTORY, user.id, {
      id,
      filename: displayName,
      source: meta.source || 'upload',
    });
  }

  log.debug('file.fetch', { fileId: id });
  return c.json({
    id,
    filename: displayName,
    content,
    created: meta.created || null,
    owned: isOwner(meta, user),
    visibility: meta.visibility || 'private',
    currentRev: meta.currentRev || 0,
  });
});

// ── File rename ─────────────────────────────────────────────────────────────

app.patch('/api/files/:id', async (c) => {
  const id = c.req.param('id');
  const { filename } = await c.req.json();

  if (!filename || !filename.trim()) {
    return c.json({ error: 'Filename is required' }, 400);
  }

  const trimmed = filename.trim();

  const user = c.get('user');
  const meta = await loadMeta(c.env.HISTORY, id);
  if (!meta || !isOwner(meta, user)) {
    c.get('logger').warn('file.notFound', { fileId: id });
    return c.json({ error: 'File not found' }, 404);
  }
  meta.filename = trimmed;
  await c.env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));
  const history = await readHistory(c.env.HISTORY, user.id);
  await writeHistory(
    c.env.HISTORY,
    user.id,
    history.map((h) => (h.id === id ? { ...h, filename: trimmed } : h))
  );

  const log = c.get('logger');
  log.info('file.rename', { fileId: id, filename: trimmed });

  return c.json({ id, filename: trimmed });
});

app.patch('/api/files/:id/visibility', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const { visibility } = await c.req.json();
  if (visibility !== 'private' && visibility !== 'link') {
    return c.json({ error: "visibility must be 'private' or 'link'" }, 400);
  }
  const meta = await loadMeta(c.env.HISTORY, id);
  if (!meta || !isOwner(meta, user)) {
    c.get('logger').warn('file.notFound', { fileId: id });
    return c.json({ error: 'File not found' }, 404);
  }
  meta.visibility = visibility;
  await c.env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));
  c.get('logger').info('file.visibility', { fileId: id, visibility });
  return c.json({ id, visibility });
});

// ── Edit + revisions ────────────────────────────────────────────────────────

app.put('/api/files/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const log = c.get('logger');
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const { content } = body;
  if (!content || typeof content !== 'string') {
    return c.json({ error: 'No content provided' }, 400);
  }
  if (content.length > MAX_NOTE_BYTES) {
    return c.json({ error: 'Note too large (max 2 MB)' }, 400);
  }
  const meta = await loadMeta(c.env.HISTORY, id);
  if (!meta || !isOwner(meta, user)) {
    log.warn('file.notFound', { fileId: id });
    return c.json({ error: 'File not found' }, 404);
  }
  const currentObj = await c.env.MD_FILES.get(`${id}.md`);
  if (!currentObj) {
    log.warn('file.notFound', { fileId: id });
    return c.json({ error: 'File not found' }, 404);
  }
  const current = await currentObj.text();
  if (content === current) {
    return c.json({ error: 'No changes' }, 400);
  }

  const revisions = await readRevisions(c.env.HISTORY, id);
  const currentRev = meta.currentRev || 0;
  const now = new Date().toISOString();

  // Lazily snapshot the original as revision 0 on the first edit.
  if (currentRev === 0 && !revisions.some((r) => r.n === 0)) {
    await c.env.MD_FILES.put(snapshotKey(id, 0), current);
    revisions.unshift({
      n: 0,
      at: meta.created || now,
      by: user.email,
      message: 'Original',
      bytes: current.length,
    });
  }

  const n = currentRev + 1;
  const revision = {
    n,
    at: now,
    by: user.email,
    message: cleanMessage(body.message),
    bytes: content.length,
  };
  await c.env.MD_FILES.put(snapshotKey(id, n), content);
  await c.env.MD_FILES.put(`${id}.md`, content);
  revisions.unshift(revision);
  while (revisions.length > REVISIONS_MAX) {
    const evicted = revisions.pop();
    await c.env.MD_FILES.delete(snapshotKey(id, evicted.n));
  }
  await c.env.HISTORY.put(revKey(id), JSON.stringify(revisions));

  meta.currentRev = n;
  meta.size = content.length;
  meta.lastAccessedAt = now;
  delete meta.archivedAt;
  await c.env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));

  log.info('file.edit', { fileId: id, rev: n, bytes: content.length });
  return c.json({ id, currentRev: n, revision });
});

app.get('/api/files/:id/revisions', async (c) => {
  const id = c.req.param('id');
  const meta = await loadMeta(c.env.HISTORY, id);
  const user = c.get('user');
  if (!meta || !canRead(meta, user)) {
    return c.json({ error: 'File not found' }, 404);
  }
  const revisions = await readRevisions(c.env.HISTORY, id);
  if (isOwner(meta, user)) return c.json(revisions);
  return c.json(revisions.map(({ by: _by, ...rest }) => rest));
});

app.get('/api/files/:id/revisions/:n', async (c) => {
  const id = c.req.param('id');
  const meta = await loadMeta(c.env.HISTORY, id);
  if (!meta || !canRead(meta, c.get('user'))) {
    return c.json({ error: 'File not found' }, 404);
  }
  if (!/^\d+$/.test(c.req.param('n'))) return c.json({ error: 'Revision not found' }, 404);
  const n = Number(c.req.param('n'));
  const revisions = await readRevisions(c.env.HISTORY, id);
  if (!revisions.some((r) => r.n === n)) return c.json({ error: 'Revision not found' }, 404);
  const obj = await c.env.MD_FILES.get(snapshotKey(id, n));
  if (!obj) return c.json({ error: 'Revision not found' }, 404);
  return c.body(await obj.text(), 200, { 'content-type': 'text/markdown; charset=utf-8' });
});

// ── Comment routes ──────────────────────────────────────────────────────────
// Owner-only review comments, one KV value per note. Anchors are resolved
// against the current markdown source on write (see public/js/anchor.js).

const MAX_COMMENTS = 500;
const MAX_COMMENT_TEXT = 2000;
const COMMENT_TAGS = ['fix', 'cut', 'q', 'keep', 'general'];
const COMMENT_STATUSES = ['open', 'addressed'];

async function readComments(kv, id) {
  const raw = await kv.get(commentsKey(id));
  if (!raw) return { nextId: 1, round: 1, items: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { nextId: 1, round: 1, items: [] };
  }
}

/** Loads meta and answers null unless the caller owns the note. */
async function ownedMeta(c) {
  const meta = await loadMeta(c.env.HISTORY, c.req.param('id'));
  if (!meta || !isOwner(meta, c.get('user'))) {
    c.get('logger').warn('file.notFound', { fileId: c.req.param('id') });
    return null;
  }
  return meta;
}

const cleanText = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_COMMENT_TEXT) : '');

function cleanAnchor(a) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.lines)) return null;
  const lines = a.lines.map(Number);
  if (lines.length !== 2 || !lines.every(Number.isInteger)) return null;
  const anchor = {
    quote: typeof a.quote === 'string' ? a.quote.slice(0, MAX_COMMENT_TEXT) : '',
    approx: Boolean(a.approx),
    prefix: typeof a.prefix === 'string' ? a.prefix.slice(-64) : '',
    suffix: typeof a.suffix === 'string' ? a.suffix.slice(0, 64) : '',
    lines,
  };
  if (a.block && typeof a.block === 'object') {
    anchor.block = {
      kind: cleanText(a.block.kind).slice(0, 40),
      label: cleanText(a.block.label).slice(0, 200),
    };
  } else if (!anchor.quote) {
    return null;
  }
  return anchor;
}

app.get('/api/files/:id/comments', async (c) => {
  if (!(await ownedMeta(c))) return c.json({ error: 'File not found' }, 404);
  const { round, items } = await readComments(c.env.HISTORY, c.req.param('id'));
  return c.json({ round, items });
});

app.post('/api/files/:id/comments', async (c) => {
  const id = c.req.param('id');
  const meta = await ownedMeta(c);
  if (!meta) return c.json({ error: 'File not found' }, 404);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const tag = body.tag;
  if (!COMMENT_TAGS.includes(tag)) return c.json({ error: 'Invalid tag' }, 400);
  const note = cleanText(body.note);
  const replace = cleanText(body.replace);
  if ((tag === 'fix' || tag === 'q' || tag === 'general') && !note && !replace) {
    return c.json({ error: 'A note is required' }, 400);
  }

  const comments = await readComments(c.env.HISTORY, id);
  if (comments.items.length >= MAX_COMMENTS) return c.json({ error: 'Too many comments' }, 400);

  let anchor;
  if (tag === 'general') {
    if (comments.items.some((i) => i.tag === 'general')) {
      return c.json({ error: 'General note already exists' }, 400);
    }
  } else {
    anchor = cleanAnchor(body.anchor);
    if (!anchor) return c.json({ error: 'Invalid anchor' }, 400);
    const obj = await c.env.MD_FILES.get(`${id}.md`);
    if (!obj) return c.json({ error: 'File not found' }, 404);
    const hit = locate(await obj.text(), anchor);
    if (!hit) return c.json({ error: 'Anchor not found' }, 409);
    anchor.lines = hit.lines;
  }

  const item = {
    id: `${tag === 'keep' ? 'k' : 'c'}${comments.nextId}`,
    tag,
    note,
    ...(replace ? { replace } : {}),
    ...(anchor ? { anchor } : {}),
    rev: meta.currentRev || 0,
    status: 'open',
    carried: 0,
    authorId: c.get('user').id,
    createdAt: new Date().toISOString(),
  };
  comments.nextId += 1;
  comments.items.push(item);
  await c.env.HISTORY.put(commentsKey(id), JSON.stringify(comments));
  c.get('logger').info('comment.create', { fileId: id, commentId: item.id, tag });
  return c.json({ item }, 201);
});

app.patch('/api/files/:id/comments/:cid', async (c) => {
  const id = c.req.param('id');
  if (!(await ownedMeta(c))) return c.json({ error: 'File not found' }, 404);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const comments = await readComments(c.env.HISTORY, id);
  const item = comments.items.find((i) => i.id === c.req.param('cid'));
  if (!item) return c.json({ error: 'Comment not found' }, 404);

  if (body.tag !== undefined && body.tag !== item.tag) {
    const fixed = ['keep', 'general'];
    if (!COMMENT_TAGS.includes(body.tag) || fixed.includes(body.tag) || fixed.includes(item.tag)) {
      return c.json({ error: 'Invalid tag change' }, 400);
    }
    item.tag = body.tag;
  }
  if (body.status !== undefined) {
    if (!COMMENT_STATUSES.includes(body.status)) return c.json({ error: 'Invalid status' }, 400);
    item.status = body.status;
  }
  if (body.note !== undefined) item.note = cleanText(body.note);
  if (body.replace !== undefined) {
    const replace = cleanText(body.replace);
    if (replace) item.replace = replace;
    else delete item.replace;
  }
  await c.env.HISTORY.put(commentsKey(id), JSON.stringify(comments));
  return c.json({ item });
});

app.delete('/api/files/:id/comments/:cid', async (c) => {
  const id = c.req.param('id');
  if (!(await ownedMeta(c))) return c.json({ error: 'File not found' }, 404);
  const comments = await readComments(c.env.HISTORY, id);
  const before = comments.items.length;
  comments.items = comments.items.filter((i) => i.id !== c.req.param('cid'));
  if (comments.items.length === before) return c.json({ error: 'Comment not found' }, 404);
  await c.env.HISTORY.put(commentsKey(id), JSON.stringify(comments));
  c.get('logger').info('comment.delete', { fileId: id, commentId: c.req.param('cid') });
  return c.json({ success: true });
});

// ── File delete ─────────────────────────────────────────────────────────────

app.delete('/api/files/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const meta = await loadMeta(c.env.HISTORY, id);
  if (!meta || !isOwner(meta, user)) {
    c.get('logger').warn('file.notFound', { fileId: id });
    return c.json({ error: 'File not found' }, 404);
  }

  await deleteNoteObjects(c.env, id);
  await c.env.HISTORY.delete(`meta:${id}`);
  await removeFromNoteIndex(c.env.HISTORY, user.id, id);

  const history = await readHistory(c.env.HISTORY, user.id);
  await writeHistory(
    c.env.HISTORY,
    user.id,
    history.filter((h) => h.id !== id)
  );

  const folders = await readFolders(c.env.HISTORY, user.id);
  let foldersChanged = false;
  for (const folder of folders) {
    const before = folder.fileIds.length;
    folder.fileIds = folder.fileIds.filter((fid) => fid !== id);
    if (folder.fileIds.length !== before) foldersChanged = true;
  }
  if (foldersChanged) await writeFolders(c.env.HISTORY, user.id, folders);

  c.get('logger').info('file.delete', { fileId: id });
  return c.json({ success: true });
});

// ── History routes ──────────────────────────────────────────────────────────

app.get('/api/history', async (c) => {
  const user = c.get('user');
  const history = await readHistory(c.env.HISTORY, user.id);
  const allMeta = await getMetaMany(
    c.env.HISTORY,
    history.map((h) => h.id)
  );

  return c.json(
    history
      .filter((h) => {
        const meta = allMeta.get(h.id);
        return meta && !meta.archivedAt && canRead(meta, user);
      })
      .map((h) => {
        const meta = allMeta.get(h.id);
        return { ...h, folderId: meta && isOwner(meta, user) ? meta.folderId || null : null };
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
  const user = c.get('user');
  const folders = await readFolders(c.env.HISTORY, user.id);
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
        if (!meta || !isOwner(meta, user)) return null;
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

  const user = c.get('user');
  const deletedIds = [];
  for (const fid of folder.fileIds) {
    const meta = await loadMeta(c.env.HISTORY, fid);
    if (!meta || !isOwner(meta, user)) continue;
    await deleteNoteObjects(c.env, fid);
    await c.env.HISTORY.delete(`meta:${fid}`);
    await removeFromNoteIndex(c.env.HISTORY, user.id, fid);
    deletedIds.push(fid);
  }

  if (deletedIds.length > 0) {
    const deleted = new Set(deletedIds);
    const history = await readHistory(c.env.HISTORY, user.id);
    await writeHistory(
      c.env.HISTORY,
      user.id,
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

  const meta = await loadMeta(c.env.HISTORY, fileId);
  if (!meta || !isOwner(meta, c.get('user'))) {
    return c.json({ error: 'File not found' }, 404);
  }

  for (const f of folders) {
    f.fileIds = f.fileIds.filter((id) => id !== fileId);
  }

  folder.fileIds.push(fileId);
  await writeFolders(c.env.HISTORY, c.get('user').id, folders);

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

  const meta = await loadMeta(c.env.HISTORY, fileId);
  if (!meta || !isOwner(meta, c.get('user'))) {
    return c.json({ error: 'File not found' }, 404);
  }

  folder.fileIds = folder.fileIds.filter((id) => id !== fileId);
  await writeFolders(c.env.HISTORY, c.get('user').id, folders);

  delete meta.folderId;
  await c.env.HISTORY.put(`meta:${fileId}`, JSON.stringify(meta));

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

  const meta = await loadMeta(c.env.HISTORY, fileId);
  if (!meta || !isOwner(meta, c.get('user'))) {
    return c.json({ error: 'File not found' }, 404);
  }

  source.fileIds = source.fileIds.filter((id) => id !== fileId);
  if (!target.fileIds.includes(fileId)) target.fileIds.push(fileId);
  await writeFolders(c.env.HISTORY, c.get('user').id, folders);

  meta.folderId = targetFolderId;
  await c.env.HISTORY.put(`meta:${fileId}`, JSON.stringify(meta));

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
