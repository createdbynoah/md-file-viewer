import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const app = new Hono();

// ── Web Crypto auth helpers ─────────────────────────────────────────────────

async function signValue(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifySignedCookie(cookieValue, secret) {
  if (!cookieValue) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return false;
  const [value, sig] = parts;
  const expected = await signValue(value, secret);
  const encoder = new TextEncoder();
  const a = encoder.encode(sig);
  const b = encoder.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

// ── History helpers ─────────────────────────────────────────────────────────

async function readHistory(kv) {
  const data = await kv.get('history');
  if (!data) return [];
  try {
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeHistory(kv, history) {
  await kv.put('history', JSON.stringify(history));
}

async function addHistoryEntry(kv, entry) {
  const now = new Date().toISOString();
  const history = await readHistory(kv);
  const filtered = history.filter((h) => h.id !== entry.id);
  filtered.unshift({ ...entry, viewedAt: now });
  // Update lastAccessedAt in metadata (authoritative timestamp for retention)
  const metaKey = `meta:${entry.id}`;
  const metaJson = await kv.get(metaKey);
  if (metaJson) {
    try {
      const meta = JSON.parse(metaJson);
      meta.lastAccessedAt = now;
      delete meta.archivedAt;
      await kv.put(metaKey, JSON.stringify(meta));
    } catch { /* leave metadata unchanged on parse error */ }
  }
  await writeHistory(kv, filtered);
}

// ── Folder helpers ──────────────────────────────────────────────────────────

function generateFolderId() {
  return 'f-' + crypto.randomUUID().slice(0, 8);
}

async function readFolders(kv) {
  const data = await kv.get('folders');
  if (!data) return [];
  try {
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeFolders(kv, folders) {
  await kv.put('folders', JSON.stringify(folders));
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
      } catch { /* skip corrupt */ }
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  return result;
}

// ── Retention cron handler ──────────────────────────────────────────────────
// Runs daily at 03:00 UTC. Archives after 30 days of inactivity, deletes after 60.

const ARCHIVE_MS = 30 * 24 * 60 * 60 * 1000;
const DELETE_MS = 60 * 24 * 60 * 60 * 1000;

async function runRetention(env) {
  const now = Date.now();
  const allMeta = await listAllMeta(env.HISTORY);
  const deletedIds = [];

  for (const [id, meta] of allMeta) {
    const ref = meta.lastAccessedAt || meta.created;
    if (!ref) continue;

    const age = now - new Date(ref).getTime();

    if (age >= DELETE_MS) {
      // KV first (safe to retry), then R2 (idempotent)
      await env.HISTORY.delete(`meta:${id}`);
      await env.MD_FILES.delete(`${id}.md`);
      deletedIds.push(id);
    } else if (age >= ARCHIVE_MS && !meta.archivedAt) {
      meta.archivedAt = new Date().toISOString();
      await env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));
    }
  }

  // Clean up history entries for deleted files in one batch
  if (deletedIds.length > 0) {
    const deleted = new Set(deletedIds);
    const history = await readHistory(env.HISTORY);
    await writeHistory(env.HISTORY, history.filter((h) => !deleted.has(h.id)));
  }
}

// ── Auth middleware ──────────────────────────────────────────────────────────

app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/api/auth/login' || path === '/api/auth/check') {
    return next();
  }
  const token = getCookie(c, 'auth');
  if (!(await verifySignedCookie(token, c.env.COOKIE_SECRET))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

// ── Auth routes ─────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (c) => {
  const { password } = await c.req.json();
  if (password !== c.env.ACCESS_PASSWORD) {
    return c.json({ error: 'Invalid password' }, 401);
  }
  const value = 'authenticated';
  const sig = await signValue(value, c.env.COOKIE_SECRET);
  const signed = `${value}.${sig}`;
  setCookie(c, 'auth', signed, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.json({ success: true });
});

app.post('/api/auth/logout', (c) => {
  deleteCookie(c, 'auth', { path: '/' });
  return c.json({ success: true });
});

app.get('/api/auth/check', async (c) => {
  const token = getCookie(c, 'auth');
  return c.json({ authenticated: await verifySignedCookie(token, c.env.COOKIE_SECRET) });
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

  const id = crypto.randomUUID();
  const content = await file.text();
  const now = new Date().toISOString();

  await c.env.MD_FILES.put(`${id}.md`, content);
  await c.env.HISTORY.put(`meta:${id}`, JSON.stringify({
    filename: originalName,
    source: 'upload',
    size: content.length,
    created: now,
    lastAccessedAt: now,
  }));
  await addHistoryEntry(c.env.HISTORY, { id, filename: originalName, source: 'upload' });

  return c.json({ id, filename: originalName });
});

// ── Paste upload ────────────────────────────────────────────────────────────

app.post('/api/paste', async (c) => {
  const { content, title } = await c.req.json();
  if (!content || typeof content !== 'string') {
    return c.json({ error: 'No content provided' }, 400);
  }

  const id = crypto.randomUUID();
  const displayName = title || 'Pasted Markdown';
  const now = new Date().toISOString();

  await c.env.MD_FILES.put(`${id}.md`, content);
  await c.env.HISTORY.put(`meta:${id}`, JSON.stringify({
    filename: displayName,
    source: 'paste',
    size: content.length,
    created: now,
    lastAccessedAt: now,
  }));
  await addHistoryEntry(c.env.HISTORY, { id, filename: displayName, source: 'paste' });

  return c.json({ id, filename: displayName });
});

// ── File listing ────────────────────────────────────────────────────────────

app.get('/api/files', async (c) => {
  const allMeta = await listAllMeta(c.env.HISTORY);
  const files = [];

  for (const [id, meta] of allMeta) {
    if (meta.archivedAt) continue;
    files.push({
      id,
      filename: meta.filename,
      displayName: meta.filename,
      source: meta.source,
      size: meta.size,
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
    return c.json({ error: 'File not found' }, 404);
  }

  const content = await object.text();

  // Get display name from metadata
  const metaJson = await c.env.HISTORY.get(`meta:${id}`);
  let displayName = `${id}.md`;
  let source = 'upload';
  if (metaJson) {
    try {
      const meta = JSON.parse(metaJson);
      displayName = meta.filename || displayName;
      source = meta.source || source;
    } catch { /* use defaults */ }
  }

  await addHistoryEntry(c.env.HISTORY, { id, filename: displayName, source });

  return c.json({ id, filename: displayName, content });
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
    return c.json({ error: 'File not found' }, 404);
  }

  const meta = JSON.parse(metaJson);
  meta.filename = trimmed;
  await c.env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));

  const history = await readHistory(c.env.HISTORY);
  const updated = history.map((h) =>
    h.id === id ? { ...h, filename: trimmed } : h
  );
  await writeHistory(c.env.HISTORY, updated);

  return c.json({ id, filename: trimmed });
});

// ── File delete ─────────────────────────────────────────────────────────────

app.delete('/api/files/:id', async (c) => {
  const id = c.req.param('id');

  await c.env.MD_FILES.delete(`${id}.md`);
  await c.env.HISTORY.delete(`meta:${id}`);

  // Remove from history
  const history = await readHistory(c.env.HISTORY);
  await writeHistory(c.env.HISTORY, history.filter((h) => h.id !== id));

  return c.json({ success: true });
});

// ── History routes ──────────────────────────────────────────────────────────

app.get('/api/history', async (c) => {
  const history = await readHistory(c.env.HISTORY);
  const allMeta = await listAllMeta(c.env.HISTORY);

  // Only show history entries for active (non-archived, non-deleted) files
  return c.json(history.filter((h) => {
    const meta = allMeta.get(h.id);
    return meta && !meta.archivedAt;
  }));
});

app.delete('/api/history', async (c) => {
  await writeHistory(c.env.HISTORY, []);
  return c.json({ success: true });
});

app.delete('/api/history/:id', async (c) => {
  const id = c.req.param('id');
  const history = await readHistory(c.env.HISTORY);
  await writeHistory(c.env.HISTORY, history.filter((h) => h.id !== id));
  return c.json({ success: true });
});

// ── Folder routes ───────────────────────────────────────────────────────────

app.get('/api/folders', async (c) => {
  const folders = await readFolders(c.env.HISTORY);
  const allMeta = await listAllMeta(c.env.HISTORY);

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

  const folders = await readFolders(c.env.HISTORY);
  folders.push(folder);
  await writeFolders(c.env.HISTORY, folders);

  return c.json(folder, 201);
});

app.patch('/api/folders/:id', async (c) => {
  const id = c.req.param('id');
  const { name } = await c.req.json();
  if (!name || !name.trim()) {
    return c.json({ error: 'Folder name is required' }, 400);
  }

  const folders = await readFolders(c.env.HISTORY);
  const folder = folders.find((f) => f.id === id);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  folder.name = name.trim();
  await writeFolders(c.env.HISTORY, folders);

  return c.json(folder);
});

app.delete('/api/folders/:id', async (c) => {
  const id = c.req.param('id');
  const folders = await readFolders(c.env.HISTORY);
  const folder = folders.find((f) => f.id === id);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  for (const fid of folder.fileIds) {
    await c.env.MD_FILES.delete(`${fid}.md`);
    await c.env.HISTORY.delete(`meta:${fid}`);
  }

  if (folder.fileIds.length > 0) {
    const deleted = new Set(folder.fileIds);
    const history = await readHistory(c.env.HISTORY);
    await writeHistory(c.env.HISTORY, history.filter((h) => !deleted.has(h.id)));
  }

  await writeFolders(c.env.HISTORY, folders.filter((f) => f.id !== id));

  return c.json({ success: true });
});

// ── SPA fallback ────────────────────────────────────────────────────────────
// Serve index.html for /<uuid> paths so direct links & browser refresh work.

const UUID_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  if (UUID_RE.test(path)) {
    const url = new URL(c.req.url);
    url.pathname = '/';
    return c.env.ASSETS.fetch(new Request(url, c.req.raw));
  }
  return c.notFound();
});

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRetention(env));
  },
};
