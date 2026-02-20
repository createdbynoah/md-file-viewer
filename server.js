import 'dotenv/config';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { watch } from 'chokidar';

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'changeme';
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret';
const WATCH_DIR = process.env.WATCH_DIR || './data/watch';
const UPLOADS_DIR = './data/uploads';
const HISTORY_FILE = './data/history.json';

// Ensure data directories exist
for (const dir of [UPLOADS_DIR, WATCH_DIR]) {
  mkdirSync(dir, { recursive: true });
}

// ── History helpers ─────────────────────────────────────────────────────────

async function readHistory() {
  try {
    const data = await readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeHistory(history) {
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
}

async function addHistoryEntry(entry) {
  const history = await readHistory();
  // Remove duplicate if same file viewed again
  const filtered = history.filter((h) => h.id !== entry.id);
  filtered.unshift({ ...entry, viewedAt: new Date().toISOString() });
  // Keep last 100 entries
  await writeHistory(filtered.slice(0, 100));
}

// ── Cookie auth helpers ─────────────────────────────────────────────────────

function signValue(value) {
  return createHmac('sha256', COOKIE_SECRET).update(value).digest('hex');
}

function verifySignedCookie(cookieValue) {
  if (!cookieValue) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return false;
  const [value, sig] = parts;
  const expected = signValue(value);
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ── Hono app ────────────────────────────────────────────────────────────────

const app = new Hono();

// Auth middleware — protect all /api/* except login
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/api/auth/login' || path === '/api/auth/check') {
    return next();
  }
  const token = getCookie(c, 'auth');
  if (!verifySignedCookie(token)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

// ── Auth routes ─────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (c) => {
  const { password } = await c.req.json();
  if (password !== ACCESS_PASSWORD) {
    return c.json({ error: 'Invalid password' }, 401);
  }
  const value = 'authenticated';
  const signed = `${value}.${signValue(value)}`;
  setCookie(c, 'auth', signed, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return c.json({ success: true });
});

app.post('/api/auth/logout', (c) => {
  deleteCookie(c, 'auth', { path: '/' });
  return c.json({ success: true });
});

app.get('/api/auth/check', (c) => {
  const token = getCookie(c, 'auth');
  return c.json({ authenticated: verifySignedCookie(token) });
});

// ── File upload ─────────────────────────────────────────────────────────────

app.post('/api/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400);
  }

  const originalName = file.name || 'untitled.md';
  if (extname(originalName).toLowerCase() !== '.md') {
    return c.json({ error: 'Only .md files are accepted' }, 400);
  }

  const id = randomUUID();
  const filename = `${id}.md`;
  const content = await file.text();
  await writeFile(join(UPLOADS_DIR, filename), content, 'utf-8');

  const entry = { id, filename: originalName, source: 'upload' };
  await addHistoryEntry(entry);

  return c.json({ id, filename: originalName });
});

// ── Paste upload ────────────────────────────────────────────────────────────

app.post('/api/paste', async (c) => {
  const { content, title } = await c.req.json();
  if (!content || typeof content !== 'string') {
    return c.json({ error: 'No content provided' }, 400);
  }

  const id = randomUUID();
  const filename = `${id}.md`;
  await writeFile(join(UPLOADS_DIR, filename), content, 'utf-8');

  const displayName = title || 'Pasted Markdown';
  const entry = { id, filename: displayName, source: 'paste' };
  await addHistoryEntry(entry);

  return c.json({ id, filename: displayName });
});

// ── File listing ────────────────────────────────────────────────────────────

app.get('/api/files', async (c) => {
  const files = [];

  // Uploaded files
  try {
    const uploadFiles = await readdir(UPLOADS_DIR);
    for (const f of uploadFiles) {
      if (extname(f).toLowerCase() === '.md') {
        const id = basename(f, '.md');
        const info = await stat(join(UPLOADS_DIR, f));
        files.push({
          id,
          filename: f,
          source: 'upload',
          size: info.size,
          modified: info.mtime.toISOString(),
        });
      }
    }
  } catch { /* empty dir */ }

  // Watched files
  try {
    const watchFiles = await readdir(WATCH_DIR);
    for (const f of watchFiles) {
      if (extname(f).toLowerCase() === '.md') {
        const id = `watch:${f}`;
        const info = await stat(join(WATCH_DIR, f));
        files.push({
          id,
          filename: f,
          source: 'watch',
          size: info.size,
          modified: info.mtime.toISOString(),
        });
      }
    }
  } catch { /* empty dir */ }

  // Augment with display names from history
  const history = await readHistory();
  const historyMap = new Map(history.map((h) => [h.id, h]));
  for (const file of files) {
    const h = historyMap.get(file.id);
    if (h && h.filename) {
      file.displayName = h.filename;
    }
  }

  return c.json(files);
});

// ── File content ────────────────────────────────────────────────────────────

app.get('/api/files/:id', async (c) => {
  const id = c.req.param('id');
  let filePath;
  let displayName;

  if (id.startsWith('watch:')) {
    const filename = id.slice(6);
    filePath = join(WATCH_DIR, filename);
    displayName = filename;
  } else {
    filePath = join(UPLOADS_DIR, `${id}.md`);
    // Look up display name from history
    const history = await readHistory();
    const entry = history.find((h) => h.id === id);
    displayName = entry?.filename || `${id}.md`;
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    await addHistoryEntry({ id, filename: displayName, source: id.startsWith('watch:') ? 'watch' : 'upload' });
    return c.json({ id, filename: displayName, content });
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

// ── File delete ─────────────────────────────────────────────────────────────

app.delete('/api/files/:id', async (c) => {
  const id = c.req.param('id');

  if (id.startsWith('watch:')) {
    return c.json({ error: 'Cannot delete watched files' }, 400);
  }

  const filePath = join(UPLOADS_DIR, `${id}.md`);
  try {
    await unlink(filePath);
    // Remove from history
    const history = await readHistory();
    await writeHistory(history.filter((h) => h.id !== id));
    return c.json({ success: true });
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

// ── History routes ──────────────────────────────────────────────────────────

app.get('/api/history', async (c) => {
  const history = await readHistory();
  return c.json(history);
});

app.delete('/api/history', async (c) => {
  await writeHistory([]);
  return c.json({ success: true });
});

app.delete('/api/history/:id', async (c) => {
  const id = c.req.param('id');
  const history = await readHistory();
  await writeHistory(history.filter((h) => h.id !== id));
  return c.json({ success: true });
});

// ── Static files (must be after API routes) ─────────────────────────────────

app.use('/*', serveStatic({ root: './public' }));

// Fallback to index.html for SPA-like behavior
app.get('*', async (c) => {
  try {
    const html = await readFile('./public/index.html', 'utf-8');
    return c.html(html);
  } catch {
    return c.text('Not found', 404);
  }
});

// ── Folder watcher ──────────────────────────────────────────────────────────

const watcher = watch(WATCH_DIR, {
  ignoreInitial: false,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});

watcher.on('add', async (filePath) => {
  if (extname(filePath).toLowerCase() !== '.md') return;
  const filename = basename(filePath);
  const id = `watch:${filename}`;
  await addHistoryEntry({ id, filename, source: 'watch' });
  console.log(`[watch] Detected: ${filename}`);
});

watcher.on('unlink', async (filePath) => {
  const filename = basename(filePath);
  const id = `watch:${filename}`;
  const history = await readHistory();
  await writeHistory(history.filter((h) => h.id !== id));
  console.log(`[watch] Removed: ${filename}`);
});

// ── Start server ────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Markdown Viewer running at http://localhost:${info.port}`);
  console.log(`Watching: ${WATCH_DIR}`);
});
