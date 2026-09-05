# Auth Step 2 — Ownership, Visibility, Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every note has an owner; notes are `private` by default or `link` (anyone with the URL can read); only the owner can write; history and folders are per user; a one-shot migration stamps existing notes to the operator's Access `sub`.

**Architecture:** Keep the single-file Hono app (`src/worker.js`) and the KV + R2 storage. `meta:{uuid}` gains `ownerId`, `visibility`, `editors`, `currentRev`. Per-user keys `user:{sub}:notes` (owner index), `history:{sub}`, `folders:{sub}` replace the global `history` / `folders` keys and the `meta:` prefix scan for listing. `GET /api/files/:id` becomes reachable anonymously and enforces visibility itself. All other writes check `meta.ownerId === user.id` and answer 404 otherwise. A pure `src/migrate.js` module does the data migration; `scripts/migrate-owner.mjs` drives it against production KV through `wrangler kv`.

**Tech Stack:** Cloudflare Workers, Hono 4, KV, R2, vitest 3 (workers pool), vanilla JS SPA.

**Spec:** `docs/plans/2026-09-04-auth-design.md` — "Data model", "Migration", "Authorization rules", "Frontend" (sign-in, ownership gates, visibility, anonymous deep links), "Testing", "Delivery order" step 2. Issues #31 #32 #34 #35 #36 #37(done) #38 #39 #70. Step 1 (identity) is merged: `c.get('user')` is `{ id, email } | null`; `X-Dev-User` switches identity under the UAT stub; test helpers `devEnv()`, `asUser(id)`, `authed()`, `paste()` in `src/test-utils/app.js`.

## Global Constraints

- Default visibility for new notes: `'private'`. Allowed values: `'private'` | `'link'`.
- Edit rights: owner only. `editors` is always `[]` and never consulted (reserved).
- Non-owner write attempts and unreadable reads return **404**, never 403.
- Anonymous surface is exactly `/api/auth/*` plus `GET /api/files/:id`. Everything else 401s without a user.
- Storage keys: `meta:{uuid}` (unchanged key, new fields), `user:{sub}:notes` (JSON array of uuids, newest first), `history:{sub}`, `folders:{sub}`. R2 key `{uuid}.md` unchanged. No D1.
- Listing a user's notes never uses `kv.list` prefix scans (eventually consistent); it reads the index then `getMetaMany`. The retention cron may still scan `meta:`.
- Legacy notes (meta without `ownerId`, pre-migration): readable by any **authenticated** user, writable by nobody (404). Anonymous → 404. This keeps the operator's notes reachable between deploy and migration. (Controller ruling; spec is silent.)
- `isDevEnv` semantics unchanged. `src/dev.integration.test.js` stays green at every commit (its expected counts change only in Task 3).
- No new runtime dependencies. No build step.
- Every commit passes `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`. Prettier: printWidth 100, singleQuote. Pre-commit hook runs eslint + prettier.
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File map

| File                                              | Responsibility                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/worker.js`                                   | Per-user KV helpers, ownership/visibility checks, route changes, retention per owner.                          |
| `src/seed.js`                                     | Seed stamps owners, adds a second owner with a private + link pair.                                            |
| `src/migrate.js` (new)                            | `migrateToOwner(kv, ownerId)` — pure, idempotent, KV-interface only.                                           |
| `scripts/migrate-owner.mjs` (new)                 | CLI: wraps `wrangler kv key …` as the KV interface and calls `migrateToOwner`.                                 |
| `src/test-utils/app.js`                           | Adds `readJson(env, key)` helper.                                                                              |
| `src/*.integration.test.js`                       | Existing suites adjusted to per-user keys; new `ownership.integration.test.js`, `migrate.integration.test.js`. |
| `public/index.html`, `js/app.js`, `css/style.css` | Ownership gates, visibility toggle + copy link, user email, anonymous read-only view.                          |
| `docs/DEPLOYMENT.md`, `CLAUDE.md`                 | Migration runbook, schema notes.                                                                               |

---

### Task 1: Per-user storage helpers + create/list routes

**Files:**

- Modify: `src/worker.js` — history helpers (`readHistory`/`writeHistory`/`addHistoryEntry`, ~lines 20–62), folder helpers (`readFolders`/`writeFolders`, ~64–82), `POST /api/upload`, `POST /api/paste`, `GET /api/files` (~312–385)
- Modify: `src/test-utils/app.js` — add `readJson`
- Modify: `src/files.integration.test.js`, `src/history.integration.test.js`, `src/folders.integration.test.js`, `src/retention.integration.test.js` — key names

**Interfaces:**

- Produces (all in `src/worker.js`, module-private):
  - `historyKey(userId) → 'history:' + userId`, `foldersKey(userId) → 'folders:' + userId`, `notesKey(userId) → 'user:' + userId + ':notes'`
  - `readHistory(kv, userId)`, `writeHistory(kv, userId, history)`, `addHistoryEntry(kv, userId, entry)` (signature gains `userId` as 2nd arg)
  - `readFolders(kv, userId)`, `writeFolders(kv, userId, folders)`
  - `readNoteIndex(kv, userId) → string[]`, `addToNoteIndex(kv, userId, id)`, `removeFromNoteIndex(kv, userId, id)`
  - `newMeta({ filename, source, size, ownerId })` → meta object with `created`, `lastAccessedAt`, `visibility: 'private'`, `editors: []`, `currentRev: 0`
- Produces (`src/test-utils/app.js`): `readJson(env, key) → Promise<any|null>`

- [ ] **Step 1: Add the test helper**

Append to `src/test-utils/app.js`:

```js
/** Parse a KV JSON value, or null when the key is absent. */
export async function readJson(env, key) {
  const raw = await env.HISTORY.get(key);
  return raw ? JSON.parse(raw) : null;
}
```

- [ ] **Step 2: Update existing tests to the per-user keys and write the new ones**

In `src/files.integration.test.js`, `src/history.integration.test.js`, `src/folders.integration.test.js`, `src/retention.integration.test.js` replace every literal `'history'` KV key with `'history:user_local_dev'` and every `'folders'` with `'folders:user_local_dev'` (both in `env.HISTORY.get(...)` and `env.HISTORY.put(...)`). Search: `grep -n "'history'\|'folders'" src/*.integration.test.js`.

Then add to `src/files.integration.test.js` inside `describe('files')`:

```js
it('paste stamps owner, private visibility and the owner index', async () => {
  const env = devEnv();
  const id = await paste('# Hi', 'Mine', env);
  const meta = JSON.parse(await env.HISTORY.get(`meta:${id}`));
  expect(meta).toMatchObject({
    ownerId: 'user_local_dev',
    visibility: 'private',
    editors: [],
    currentRev: 0,
  });
  expect(JSON.parse(await env.HISTORY.get('user:user_local_dev:notes'))).toEqual([id]);
});

it('upload stamps owner and index too', async () => {
  const env = devEnv();
  const form = new FormData();
  form.append('file', new File(['# up'], 'doc.md', { type: 'text/markdown' }));
  const { id } = await (await authed('/api/upload', { method: 'POST', body: form }, env)).json();
  const meta = JSON.parse(await env.HISTORY.get(`meta:${id}`));
  expect(meta).toMatchObject({ ownerId: 'user_local_dev', visibility: 'private' });
  expect(JSON.parse(await env.HISTORY.get('user:user_local_dev:notes'))).toEqual([id]);
});

it('list returns only the caller’s notes, newest first', async () => {
  const env = devEnv();
  const a = await paste('a', 'A', env);
  const b = await paste('b', 'B', env);
  const bobRes = await authed(
    '/api/paste',
    json({ content: 'c', title: 'C' }, { headers: asUser('bob') }),
    env
  );
  const c = (await bobRes.json()).id;

  const mine = await (await authed('/api/files', {}, env)).json();
  expect(mine.map((f) => f.id)).toEqual([b, a]);
  const bobs = await (await authed('/api/files', { headers: asUser('bob') }, env)).json();
  expect(bobs.map((f) => f.id)).toEqual([c]);
});
```

Update the import line of that file to `import { authed, json, devEnv, paste, clearAll, asUser } from './test-utils/app.js';`.

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm vitest run --project integration src/files.integration.test.js`
Expected: the three new tests fail (`ownerId` undefined; `user:user_local_dev:notes` null; list returns all notes). Other files’ key renames also fail until Step 4.

- [ ] **Step 4: Implement the helpers and route changes in `src/worker.js`**

Replace the `// ── History helpers` block through `addHistoryEntry` with:

```js
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
```

Replace `readFolders`/`writeFolders`:

```js
async function readFolders(kv, userId) {
  return readJsonArray(kv, foldersKey(userId));
}

async function writeFolders(kv, userId, folders) {
  await kv.put(foldersKey(userId), JSON.stringify(folders));
}
```

`POST /api/upload` — replace from `const id = crypto.randomUUID();` to the end of the handler:

```js
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
```

`POST /api/paste` — same shape:

```js
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
```

`GET /api/files`:

```js
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
```

Now fix every remaining caller so the file compiles and the old suites pass: `GET /api/files/:id` calls `addHistoryEntry(c.env.HISTORY, c.get('user').id, {...})` **and** `await touchMeta(c.env.HISTORY, id)` (the old `addHistoryEntry` did the touch; Task 2 rewrites this handler fully, so keep it minimal here). `PATCH /api/files/:id`, `DELETE /api/files/:id`, all `/api/history*` and `/api/folders*` handlers: pass `c.get('user').id` as the second argument to `readHistory`/`writeHistory`/`readFolders`/`writeFolders`. `DELETE /api/folders/:id` likewise uses `c.get('user').id`. `runRetention` has no user; make it per-owner now (Task 3 only verifies it): replace its `const folders = await readFolders(env.HISTORY);` with a per-owner cache:

```js
const foldersByOwner = new Map();
async function ownerFolderIds(ownerId) {
  if (!ownerId) return new Set();
  if (!foldersByOwner.has(ownerId)) {
    const f = await readFolders(env.HISTORY, ownerId);
    foldersByOwner.set(ownerId, new Set(f.map((x) => x.id)));
  }
  return foldersByOwner.get(ownerId);
}
```

and inside the loop use `const folderIds = await ownerFolderIds(meta.ownerId);`. Replace the trailing history cleanup with per-owner cleanup:

```js
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
```

where `deletedByOwner` is a `Map<string, string[]>` filled at delete time (`if (meta.ownerId) { … push }`) alongside `deletedIds`.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS. `dev.integration.test.js` still expects `files` length 7 and folders `[2, 1, 0]` — the seed still writes legacy keys, so under the stub user `GET /api/files` now returns **0** (index empty). That test will fail here; that is expected and is fixed in Task 3. To keep the gate green at this commit, temporarily change those two assertions in `dev.integration.test.js` to `expect(files).toHaveLength(0)` and `expect(folders.map((f) => f.files.length)).toEqual([])` with a `// TODO(step2 task 3): seed writes legacy keys` comment. Task 3 restores real expectations.

- [ ] **Step 6: Lint, typecheck, format, commit**

Run: `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`

```bash
git add src/worker.js src/test-utils/app.js src/*.integration.test.js
git commit -m "feat(worker): per-user history/folders/note index, owner-stamped meta

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Visibility + ownership enforcement on read/write routes

**Files:**

- Modify: `src/worker.js` — auth middleware; `GET /api/files/:id`; `PATCH /api/files/:id`; new `PATCH /api/files/:id/visibility`; `DELETE /api/files/:id`; `GET /api/history`; folder file routes (`POST /api/folders/:id/files`, `DELETE /api/folders/:id/files/:fileId`, `POST /api/folders/:id/files/:fileId/move`)
- Test: `src/ownership.integration.test.js` (new)

**Interfaces:**

- Consumes: Task 1 helpers.
- Produces (module-private): `loadMeta(kv, id) → meta|null`, `canRead(meta, user) → boolean`, `isOwner(meta, user) → boolean`, `PUBLIC_FILE_RE = /^\/api\/files\/[^/]+$/`.
- Route contracts:
  - `GET /api/files/:id` → `{ id, filename, content, created, owned, visibility }`; 404 when unreadable or missing.
  - `PATCH /api/files/:id/visibility` body `{ visibility: 'private'|'link' }` → `{ id, visibility }`; 400 invalid; 404 non-owner.

- [ ] **Step 1: Write the failing tests**

`src/ownership.integration.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { call, authed, json, devEnv, paste, clearAll, asUser, readJson } from './test-utils/app.js';

const alice = () => devEnv({ AUTH_STUB_USER: 'alice' });
const bob = { headers: asUser('bob') };

async function setVisibility(env, id, visibility) {
  const res = await authed(
    `/api/files/${id}/visibility`,
    json({ visibility }, { method: 'PATCH' }),
    env
  );
  return res;
}

describe('ownership + visibility', () => {
  beforeEach(() => clearAll());

  it('private note: owner reads (owned:true), bob and anon get 404', async () => {
    const env = alice();
    const id = await paste('secret', 'S', env);
    const mine = await (await authed(`/api/files/${id}`, {}, env)).json();
    expect(mine).toMatchObject({ id, owned: true, visibility: 'private', content: 'secret' });
    expect((await authed(`/api/files/${id}`, bob, env)).status).toBe(404);
    // anonymous: base env has no stub → resolveUser() is null (ACCESS vars point nowhere)
    expect((await call(`/api/files/${id}`)).status).toBe(404);
  });

  it('link note: anyone can read, owned reflects the caller', async () => {
    const env = alice();
    const id = await paste('shared', 'L', env);
    const res = await setVisibility(env, id, 'link');
    expect(await res.json()).toEqual({ id, visibility: 'link' });

    const bobView = await (await authed(`/api/files/${id}`, bob, env)).json();
    expect(bobView).toMatchObject({ owned: false, visibility: 'link', content: 'shared' });
    const anon = await call(`/api/files/${id}`);
    expect(anon.status).toBe(200);
    expect(await anon.json()).toMatchObject({ owned: false, visibility: 'link' });
  });

  it('reads append history only for the authenticated viewer', async () => {
    const env = alice();
    const id = await paste('shared', 'L', env);
    await setVisibility(env, id, 'link');
    await env.HISTORY.put('history:alice', '[]');
    await authed(`/api/files/${id}`, bob, env);
    await call(`/api/files/${id}`);
    expect((await readJson(env, 'history:bob')).map((h) => h.id)).toEqual([id]);
    expect(await readJson(env, 'history:alice')).toEqual([]);
  });

  it('visibility endpoint validates and is owner-only', async () => {
    const env = alice();
    const id = await paste('x', 'X', env);
    expect((await setVisibility(env, id, 'public')).status).toBe(400);
    const bobTry = await authed(
      `/api/files/${id}/visibility`,
      json({ visibility: 'link' }, { method: 'PATCH', ...bob }),
      env
    );
    expect(bobTry.status).toBe(404);
    expect((await readJson(env, `meta:${id}`)).visibility).toBe('private');
    expect(
      (await call(`/api/files/${id}/visibility`, json({ visibility: 'link' }, { method: 'PATCH' })))
        .status
    ).toBe(401);
  });

  it('rename and delete are owner-only (404 for bob), even on link notes', async () => {
    const env = alice();
    const id = await paste('x', 'X', env);
    await setVisibility(env, id, 'link');
    expect(
      (await authed(`/api/files/${id}`, json({ filename: 'Y' }, { method: 'PATCH', ...bob }), env))
        .status
    ).toBe(404);
    expect((await authed(`/api/files/${id}`, { method: 'DELETE', ...bob }, env)).status).toBe(404);
    expect(await env.MD_FILES.get(`${id}.md`)).not.toBeNull();
    expect((await authed(`/api/files/${id}`, { method: 'DELETE' }, env)).status).toBe(200);
    expect(await readJson(env, 'user:alice:notes')).toEqual([]);
  });

  it('folders: bob cannot file alice’s note into his folder', async () => {
    const env = alice();
    const id = await paste('x', 'X', env);
    const folder = await (await authed('/api/folders', json({ name: 'B' }, bob), env)).json();
    const res = await authed(`/api/folders/${folder.id}/files`, json({ fileId: id }, bob), env);
    expect(res.status).toBe(404);
    expect((await readJson(env, `meta:${id}`)).folderId).toBeUndefined();
  });

  it('history hides notes the viewer can no longer read', async () => {
    const env = alice();
    const id = await paste('x', 'X', env);
    await setVisibility(env, id, 'link');
    await authed(`/api/files/${id}`, bob, env);
    expect((await (await authed('/api/history', bob, env)).json()).map((h) => h.id)).toEqual([id]);
    await setVisibility(env, id, 'private');
    expect(await (await authed('/api/history', bob, env)).json()).toEqual([]);
  });

  it('legacy note without ownerId: readable by any authed user, writable by none', async () => {
    const env = alice();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await env.MD_FILES.put(`${id}.md`, 'old');
    await env.HISTORY.put(
      `meta:${id}`,
      JSON.stringify({
        filename: 'Old',
        source: 'paste',
        size: 3,
        created: '2026-01-01T00:00:00.000Z',
      })
    );
    expect((await authed(`/api/files/${id}`, {}, env)).status).toBe(200);
    expect((await authed(`/api/files/${id}`, bob, env)).status).toBe(200);
    expect((await call(`/api/files/${id}`)).status).toBe(404);
    expect(
      (await authed(`/api/files/${id}`, json({ filename: 'N' }, { method: 'PATCH' }), env)).status
    ).toBe(404);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run --project integration src/ownership.integration.test.js`
Expected: FAIL — anonymous read 401 (not 404/200), no `owned` field, visibility route 404, bob can rename/delete.

- [ ] **Step 3: Implement**

Add after `getMetaMany` in `src/worker.js`:

```js
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

const PUBLIC_FILE_RE = /^\/api\/files\/[^/]+$/;
```

Auth middleware — change the anonymous allow-list:

```js
if (path.startsWith('/api/auth/')) return next();
if (c.req.method === 'GET' && PUBLIC_FILE_RE.test(path)) return next();
```

`GET /api/files/:id` — full replacement:

```js
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

  await touchMeta(c.env.HISTORY, id);
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
  });
});
```

`PATCH /api/files/:id` — replace the `metaJson` lookup with:

```js
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
```

New route directly after it:

```js
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
```

Register order matters: Hono matches `/api/files/:id` for `PATCH /api/files/x/visibility`? No — `:id` matches one segment only, so `/api/files/x/visibility` does not match `/api/files/:id`. Fine either order.

`DELETE /api/files/:id` — prepend the ownership check and use per-user keys:

```js
app.delete('/api/files/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const meta = await loadMeta(c.env.HISTORY, id);
  if (!meta || !isOwner(meta, user)) {
    c.get('logger').warn('file.notFound', { fileId: id });
    return c.json({ error: 'File not found' }, 404);
  }

  await c.env.MD_FILES.delete(`${id}.md`);
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
```

`GET /api/history` — filter on readability:

```js
      .filter((h) => {
        const meta = allMeta.get(h.id);
        return meta && !meta.archivedAt && canRead(meta, user);
      })
```

(with `const user = c.get('user');` at the top of the handler.)

Folder file routes: in `POST /api/folders/:id/files`, after loading `metaJson`, parse it and check `isOwner(meta, c.get('user'))`, else 404 `File not found`. In `DELETE /api/folders/:id/files/:fileId` and `.../move`, only mutate `meta.folderId` when `isOwner(meta, user)` (the folder itself is already the caller's). `DELETE /api/folders/:id` deletes files: only delete R2/meta for files where `isOwner`; also `removeFromNoteIndex` for each deleted id.

- [ ] **Step 4: Run all tests**

Run: `pnpm test`
Expected: PASS (ownership suite + all existing suites).

- [ ] **Step 5: Lint, typecheck, format, commit**

```bash
git add src/worker.js src/ownership.integration.test.js
git commit -m "feat(worker): note visibility, owner-only writes, public link reads

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Seed with owners + retention per owner + restore dev guardrails

**Files:**

- Modify: `src/seed.js`
- Modify: `src/worker.js` — `runRetention` (already per-owner from Task 1; verify it also skips notes it cannot attribute)
- Modify: `src/dev.integration.test.js` — restore real expectations, add a second-owner check
- Modify: `src/retention.integration.test.js` — per-owner folder exemption + index/history cleanup

**Interfaces:**

- Seed writes: `meta:*` with `ownerId`, `visibility`, `editors`, `currentRev`; `user:user_local_dev:notes`; `history:user_local_dev`; `folders:user_local_dev`; second owner `other_user` with `user:other_user:notes` containing one `private` and one `link` note. Exports `SEED_IDS.otherPrivate`, `SEED_IDS.otherLink`.
- Counts returned by `seedScenarios`: `{ notes: 11, folders: 3, history: 6 }`.

- [ ] **Step 1: Update tests**

`src/dev.integration.test.js` — in `'uat + stub bypasses auth and exposes seed'` restore/replace:

```js
expect(await seed.json()).toMatchObject({ ok: true, notes: 11, folders: 3 });
const files = await (await call('/api/files', {}, env)).json();
expect(files).toHaveLength(7); // own, non-archived
const folders = await (await call('/api/folders', {}, env)).json();
expect(folders.map((f) => f.files.length)).toEqual([2, 1, 0]);
// second owner: link note readable by the stub user, private one is not
const { SEED_IDS } = await import('./seed.js');
expect((await call(`/api/files/${SEED_IDS.otherLink}`, {}, env)).status).toBe(200);
expect((await call(`/api/files/${SEED_IDS.otherPrivate}`, {}, env)).status).toBe(404);
const other = await (
  await call('/api/files', { headers: { 'x-dev-user': 'other_user' } }, env)
).json();
expect(other.map((f) => f.id).sort()).toEqual([SEED_IDS.otherLink, SEED_IDS.otherPrivate].sort());
```

and in `'seed is idempotent…'` keep `toHaveLength(7)`. Remove the TODO placeholders from Task 1.

`src/retention.integration.test.js` — add:

```js
it('folder exemption is per owner; deletion prunes owner history and index', async () => {
  const env = devEnv();
  const mine = await paste('m', 'Mine', env);
  const bobsEnv = devEnv({ AUTH_STUB_USER: 'bob' });
  const bobs = await paste('b', 'Bobs', bobsEnv);
  // bob puts his note in a folder → exempt; mine is bare → deleted at 61d
  const folder = await (await authed('/api/folders', json({ name: 'F' }), bobsEnv)).json();
  await authed(`/api/folders/${folder.id}/files`, json({ fileId: bobs }), bobsEnv);
  await setAccessed(env, mine, 61);
  await setAccessed(env, bobs, 61);

  await runScheduled(env);

  expect(await env.HISTORY.get(`meta:${mine}`)).toBeNull();
  expect(await env.HISTORY.get(`meta:${bobs}`)).not.toBeNull();
  expect(JSON.parse(await env.HISTORY.get('user:user_local_dev:notes'))).toEqual([]);
  expect(
    JSON.parse(await env.HISTORY.get('history:user_local_dev')).map((h) => h.id)
  ).not.toContain(mine);
  expect(JSON.parse(await env.HISTORY.get('user:bob:notes'))).toEqual([bobs]);
});
```

Add `authed, json` to that file’s import.

- [ ] **Step 2: Run to see failures**

Run: `pnpm vitest run --project integration src/dev.integration.test.js src/retention.integration.test.js`
Expected: dev seed counts/ids fail; retention per-owner test may already pass from Task 1 — if it passes, note it in the report and keep it.

- [ ] **Step 3: Update `src/seed.js`**

- Add `otherPrivate: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'` and `otherLink: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'` to `SEED_IDS`.
- `note()` gains `ownerId = OWNER` and `visibility = 'private'` options and writes `ownerId, visibility, editors: [], currentRev: 0` into meta. `const OWNER = 'user_local_dev'; const OTHER = 'other_user';`
- Make the `wide` note `visibility: 'link'` (a shareable sample for UAT).
- Append two notes: `note(SEED_IDS.otherPrivate, 'Other private', '# Other\n\nPrivate to other_user.\n', { ownerId: OTHER })` and `note(SEED_IDS.otherLink, 'Other shared', '# Other\n\nShared by link.\n', { ownerId: OTHER, visibility: 'link' })`.
- After writing notes: `await env.HISTORY.put('user:user_local_dev:notes', JSON.stringify(<ids of OWNER notes, newest created first>))` and the same for `user:other_user:notes`. Compute order by sorting the owner's notes by `meta.created` descending.
- Write `folders:user_local_dev` (not `folders`) and `history:user_local_dev` (not `history`).
- Return `{ notes: notes.length, folders: folders.length, history: history.length }` (now 11/3/6).

- [ ] **Step 4: Verify `runRetention`** in `src/worker.js` already (from Task 1): resolves folder exemption via `folders:{meta.ownerId}`, prunes `history:{ownerId}` and `user:{ownerId}:notes` for deleted notes, and simply skips folder exemption for meta without `ownerId`. Adjust if anything is missing.

- [ ] **Step 5: Run the whole suite, gate, commit**

Run: `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`

```bash
git add src/seed.js src/worker.js src/dev.integration.test.js src/retention.integration.test.js
git commit -m "feat: seed owners + shared link note; retention per owner

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Migration module + CLI

**Files:**

- Create: `src/migrate.js`, `src/migrate.integration.test.js`, `scripts/migrate-owner.mjs`
- Modify: `package.json` scripts: `"migrate:owner": "node scripts/migrate-owner.mjs"`

**Interfaces:**

- `migrateToOwner(kv, ownerId, { log } = {}) → Promise<{ stamped: number, skipped: number, indexed: number, movedHistory: boolean, movedFolders: boolean }>` where `kv` implements `list({prefix, cursor}) → {keys:[{name}], list_complete, cursor}`, `get(key) → string|null`, `put(key, value)`, `delete(key)`.
- Behaviour: every `meta:*` lacking `ownerId` gets `ownerId, visibility: 'link', editors: [], currentRev: 0` (stamped); meta already owned is skipped. `user:{owner}:notes` = existing index ∪ all stamped ids, ordered by `created` desc. Legacy `history` → `history:{owner}` (merged ahead of any existing per-user history, deduped by id, capped 100) then deleted; legacy `folders` → `folders:{owner}` (only if no per-user folders exist yet; otherwise appended) then deleted. Idempotent: second run stamps 0, moves nothing.

- [ ] **Step 1: Write the failing test**

`src/migrate.integration.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env as baseEnv } from 'cloudflare:test';
import { clearAll, readJson, makeEnv } from './test-utils/app.js';
import { migrateToOwner } from './migrate.js';

const OWNER = 'sub-noah';
const legacyMeta = (filename, created) =>
  JSON.stringify({ filename, source: 'paste', size: 1, created, lastAccessedAt: created });

describe('migrateToOwner', () => {
  beforeEach(() => clearAll());

  it('stamps legacy meta, builds the index, moves history and folders, and is idempotent', async () => {
    const env = makeEnv();
    const kv = baseEnv.HISTORY;
    await kv.put('meta:a', legacyMeta('A', '2026-01-01T00:00:00.000Z'));
    await kv.put('meta:b', legacyMeta('B', '2026-02-01T00:00:00.000Z'));
    await kv.put(
      'meta:c',
      JSON.stringify({
        filename: 'C',
        ownerId: 'someone-else',
        visibility: 'private',
        created: '2026-03-01T00:00:00.000Z',
      })
    );
    await kv.put(
      'history',
      JSON.stringify([
        { id: 'b', filename: 'B', source: 'paste', viewedAt: '2026-02-02T00:00:00.000Z' },
      ])
    );
    await kv.put(
      'folders',
      JSON.stringify([
        { id: 'f-1', name: 'F', fileIds: ['a'], created: '2026-01-05T00:00:00.000Z' },
      ])
    );

    const r1 = await migrateToOwner(kv, OWNER);
    expect(r1).toEqual({
      stamped: 2,
      skipped: 1,
      indexed: 2,
      movedHistory: true,
      movedFolders: true,
    });
    expect(await readJson(env, 'meta:a')).toMatchObject({
      ownerId: OWNER,
      visibility: 'link',
      editors: [],
      currentRev: 0,
    });
    expect((await readJson(env, 'meta:c')).ownerId).toBe('someone-else');
    expect(await readJson(env, `user:${OWNER}:notes`)).toEqual(['b', 'a']);
    expect((await readJson(env, `history:${OWNER}`)).map((h) => h.id)).toEqual(['b']);
    expect((await readJson(env, `folders:${OWNER}`)).map((f) => f.id)).toEqual(['f-1']);
    expect(await kv.get('history')).toBeNull();
    expect(await kv.get('folders')).toBeNull();

    const r2 = await migrateToOwner(kv, OWNER);
    expect(r2).toEqual({
      stamped: 0,
      skipped: 3,
      indexed: 0,
      movedHistory: false,
      movedFolders: false,
    });
    expect(await readJson(env, `user:${OWNER}:notes`)).toEqual(['b', 'a']);
  });

  it('merges into an existing per-user index/history without duplicates', async () => {
    const env = makeEnv();
    const kv = baseEnv.HISTORY;
    await kv.put('meta:old', legacyMeta('Old', '2026-01-01T00:00:00.000Z'));
    await kv.put(
      'meta:new',
      JSON.stringify({
        filename: 'New',
        ownerId: OWNER,
        visibility: 'private',
        created: '2026-04-01T00:00:00.000Z',
      })
    );
    await kv.put(`user:${OWNER}:notes`, JSON.stringify(['new']));
    await kv.put(
      `history:${OWNER}`,
      JSON.stringify([{ id: 'new', filename: 'New', viewedAt: '2026-04-02T00:00:00.000Z' }])
    );
    await kv.put(
      'history',
      JSON.stringify([
        { id: 'old', filename: 'Old', viewedAt: '2026-01-02T00:00:00.000Z' },
        { id: 'new', filename: 'New', viewedAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    await migrateToOwner(kv, OWNER);
    expect(await readJson(env, `user:${OWNER}:notes`)).toEqual(['new', 'old']);
    expect((await readJson(env, `history:${OWNER}`)).map((h) => h.id)).toEqual(['new', 'old']);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --project integration src/migrate.integration.test.js`
Expected: FAIL — `./migrate.js` not found.

- [ ] **Step 3: Implement `src/migrate.js`**

```js
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
  while (true) {
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
```

- [ ] **Step 4: Run the test → PASS**

Run: `pnpm vitest run --project integration src/migrate.integration.test.js`

- [ ] **Step 5: CLI `scripts/migrate-owner.mjs`**

```js
#!/usr/bin/env node
// One-shot production migration: stamp every legacy note to OWNER_SUB and move
// the global history/folders keys to per-user keys. Idempotent.
//
//   pnpm migrate:owner <owner-sub>            # against the remote HISTORY namespace
//   pnpm migrate:owner <owner-sub> --local    # against the local wrangler dev store
//
// Find your sub: sign in once, then `wrangler kv key list --binding HISTORY --remote --prefix user:`.
import { execFileSync } from 'node:child_process';
import { migrateToOwner } from '../src/migrate.js';

const [ownerId, ...flags] = process.argv.slice(2);
if (!ownerId) {
  console.error('usage: migrate-owner.mjs <owner-sub> [--local]');
  process.exit(1);
}
const target = flags.includes('--local') ? '--local' : '--remote';

function wrangler(args, input) {
  return execFileSync(
    'pnpm',
    ['exec', 'wrangler', 'kv', 'key', ...args, '--binding', 'HISTORY', target],
    {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
    }
  );
}

const kv = {
  async list({ prefix }) {
    const out = wrangler(['list', '--prefix', prefix]);
    return { keys: JSON.parse(out), list_complete: true };
  },
  async get(key) {
    try {
      return wrangler(['get', key, '--text']);
    } catch {
      return null;
    }
  },
  async put(key, value) {
    wrangler(['put', key, '--path', '/dev/stdin'], value);
  },
  async delete(key) {
    wrangler(['delete', key, '--force']);
  },
};

const result = await migrateToOwner(kv, ownerId, {
  log: (msg, data) => console.log(msg, data ? JSON.stringify(data) : ''),
});
console.log('done', JSON.stringify(result));
```

`wrangler kv key get` exits non-zero for a missing key — hence the `try/catch → null`. `--path /dev/stdin` with `input` streams the value. Verify flags against the installed wrangler (`pnpm exec wrangler kv key put --help`) and adjust if the syntax differs; record the verified command line in the report.

Add to `package.json` scripts: `"migrate:owner": "node scripts/migrate-owner.mjs"`.

- [ ] **Step 6: Smoke-test the CLI locally**

Run `pnpm dev` (plain, no stub) in the background, in another shell:

```bash
pnpm exec wrangler kv key put meta:11111111-1111-4111-8111-111111111111 '{"filename":"Legacy","source":"paste","size":1,"created":"2026-01-01T00:00:00.000Z"}' --binding HISTORY --local
pnpm migrate:owner sub-test --local
pnpm exec wrangler kv key get user:sub-test:notes --binding HISTORY --local --text
```

Expected: `done {"stamped":1,…}` and the index prints `["11111111-…"]`. Stop `pnpm dev`. Clean up: `pnpm exec wrangler kv key delete … --local --force` for the two keys (or leave; `.wrangler/` is gitignored).

- [ ] **Step 7: Gate + commit**

```bash
git add src/migrate.js src/migrate.integration.test.js scripts/migrate-owner.mjs package.json
git commit -m "feat: one-shot owner migration module + wrangler kv CLI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Frontend — ownership gates, visibility toggle, user email, anonymous read-only deep links

**Files:**

- Modify: `public/index.html` (topbar ~lines 53–148, viewer actions ~213–226, sidebar ~149–180)
- Modify: `public/js/app.js` (element refs ~42–71; `checkAuth`/`showLogin`/`showApp` ~319–357; `viewFile` ~903–931; `showInputArea` ~980–995; title rename guard ~1040)
- Modify: `public/css/style.css`

**Interfaces:**

- Consumes: `GET /api/auth/check` → `{ authenticated, user: { id, email } }`; `GET /api/files/:id` → `{ …, owned, visibility }` (anonymous-capable); `PATCH /api/files/:id/visibility`.
- Produces: `currentNote = { id, owned, visibility } | null` module state; `applyOwnerControls()`; `showReadOnly(data)` for anonymous viewers; `tryLoadPublicFile(id)`.

- [ ] **Step 1: Markup**

`public/index.html`:

1. Topbar, just before `#logout-btn`: `<a id="topbar-signin" class="text-btn" href="/api/auth/login" hidden>Sign in</a>`.
2. Viewer actions (`<div>` holding `#folder-btn`, `#copy-md-btn`, `#delete-file-btn`): add before `#delete-file-btn`:
   ```html
   <button id="visibility-btn" class="text-btn" hidden></button>
   <button id="copy-link-btn" class="text-btn" hidden>Copy link</button>
   ```
   and add `hidden` to `#delete-file-btn`.
3. Sidebar: append as the last child of `<aside id="sidebar">`:
   ```html
   <div class="sidebar-footer"><span id="user-email" class="user-email"></span></div>
   ```

- [ ] **Step 2: CSS** — append to `public/css/style.css`:

```css
.sidebar-footer {
  margin-top: auto;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  font-size: 0.8125rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

body.read-only #sidebar,
body.read-only #sidebar-toggle,
body.read-only #sidebar-overlay,
body.read-only #back-btn {
  display: none !important;
}
```

`#sidebar` must be a flex column for `margin-top: auto` to push the footer down; check `.sidebar` rules and add `display: flex; flex-direction: column;` if missing (the history list already scrolls "as one unit" — verify the change does not break that; if it does, drop `margin-top: auto` and keep the footer static at the bottom of the scroll content).

- [ ] **Step 3: JS**

Element refs (add near line 71):

```js
const topbarSignin = document.getElementById('topbar-signin');
const visibilityBtn = document.getElementById('visibility-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');
const userEmail = document.getElementById('user-email');
```

Replace the `currentUser` declaration + comment with `let currentUser = null;` and add `let currentNote = null; // { id, owned, visibility }`.

Replace `checkAuth`:

```js
async function checkAuth() {
  try {
    const res = await api('/api/auth/check');
    const data = await res.json();
    currentUser = data.user || null;
    if (data.authenticated) {
      showApp();
      return;
    }
    const deepLinkId = getFileIdFromPath();
    if (deepLinkId && (await tryLoadPublicFile(deepLinkId))) return;
    showLogin();
  } catch {
    showLogin();
  }
}

// Anonymous visitor on a /<id> link: render read-only if the note is shared.
async function tryLoadPublicFile(id) {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}`);
  if (!res.ok) return false;
  const data = await res.json();
  document.body.classList.add('read-only');
  loginScreen.hidden = true;
  appScreen.hidden = false;
  logoutBtn.hidden = true;
  topbarSignin.hidden = false;
  topbarSignin.href = `/api/auth/login?next=${encodeURIComponent(location.pathname)}`;
  currentRawMarkdown = data.content;
  currentNote = { id, owned: false, visibility: data.visibility };
  renderMarkdown(data.content, data.filename, null);
  copyMdBtn.hidden = false;
  applyOwnerControls();
  if (location.pathname !== filePath(id)) history.replaceState(null, '', filePath(id));
  return true;
}
```

In `showApp()` add at the top: `userEmail.textContent = currentUser ? currentUser.email : ''; logoutBtn.hidden = false; topbarSignin.hidden = true; document.body.classList.remove('read-only');`.

In `viewFile()`, after `currentFileId = id;` replace the three `.hidden = false` lines with:

```js
currentNote = { id, owned: Boolean(data.owned), visibility: data.visibility || 'private' };
copyMdBtn.hidden = false;
applyOwnerControls();
```

and change `renderMarkdown(data.content, data.filename, id)` to `renderMarkdown(data.content, data.filename, data.owned ? id : null)` so the title is only editable for owners.

Add after `viewFile`:

```js
// Owner-only controls: delete, folder, visibility. Copy-link only when shared.
function applyOwnerControls() {
  const owned = Boolean(currentNote && currentNote.owned);
  deleteFileBtn.hidden = !owned;
  folderBtn.hidden = !owned;
  visibilityBtn.hidden = !owned;
  copyLinkBtn.hidden = !(currentNote && currentNote.visibility === 'link');
  if (owned) {
    visibilityBtn.textContent =
      currentNote.visibility === 'link' ? 'Shared: anyone with link' : 'Private';
    visibilityBtn.title = 'Click to toggle sharing';
  }
}

visibilityBtn.addEventListener('click', async () => {
  if (!currentNote || !currentNote.owned) return;
  const visibility = currentNote.visibility === 'link' ? 'private' : 'link';
  const res = await api(`/api/files/${encodeURIComponent(currentNote.id)}/visibility`, {
    method: 'PATCH',
    body: JSON.stringify({ visibility }),
  });
  if (!res.ok) return;
  currentNote.visibility = visibility;
  applyOwnerControls();
});

copyLinkBtn.addEventListener('click', () => {
  if (!currentNote) return;
  navigator.clipboard.writeText(location.origin + filePath(currentNote.id));
  const orig = copyLinkBtn.textContent;
  copyLinkBtn.textContent = 'Copied!';
  setTimeout(() => {
    copyLinkBtn.textContent = orig;
  }, 1500);
});
```

In `showInputArea()` add `currentNote = null; visibilityBtn.hidden = true; copyLinkBtn.hidden = true; deleteFileBtn.hidden = true;`.

The inline title-rename handler already checks `data-editable`, which is now `false` for non-owners. The `deleteFileBtn` handler needs no change (hidden for non-owners; server 404s anyway).

- [ ] **Step 4: Verify in the browser**

`pnpm uat` (seeded; stub user owns 9 notes, `other_user` owns 2):

1. Open the printed URL → sidebar shows `user_local_dev@dev.local` in the footer.
2. Open "Wide table" (seeded as `link`): buttons show `Shared: anyone with link`, `Copy link`, Delete, Move to Folder. Click the visibility button → becomes `Private`, Copy link disappears; click again → back.
3. Navigate to `/<short id of SEED_IDS.otherLink>`: renders, no Delete/Move/visibility buttons, title not editable. `/<short id of SEED_IDS.otherPrivate>`: viewer stays on input area (404 → `viewFile` returns).
4. Anonymous path (`pnpm dev`, no stub, separate local store so no shared notes exist): open `http://localhost:8787/` → login card. Open `http://localhost:8787/<any valid 25-char base36 id>` → network shows `GET /api/files/<id>` → 404, then the login card with `?next=/<id>` on the Sign in link. Screenshot both. Note in the report that the 200 branch of the anonymous UI (`tryLoadPublicFile` rendering) was exercised only under the UAT stub via step 3, where `otherLink` renders identically because the stub user is not its owner; the `body.read-only` branch itself cannot be reached under the stub — verify it by temporarily loading the UAT page with DevTools → `document.body.classList.add('read-only')` and confirming the sidebar/toggle/back button hide.

Stop servers when done.

- [ ] **Step 5: Gate + commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(frontend): owner controls, share-by-link toggle, read-only public notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Docs

**Files:**

- Modify: `CLAUDE.md` — Storage bindings paragraph, API table, Key Patterns
- Modify: `docs/DEPLOYMENT.md` — new "### 3. Migrate existing notes" after the Access section (renumber following sections)

- [ ] **Step 1: `CLAUDE.md`**

Storage bindings → replace the `HISTORY` line:

```
- `HISTORY` — KV namespace: `meta:{uuid}` (per-file metadata incl. `ownerId`, `visibility: 'private'|'link'`, `editors`, `currentRev`), `user:{sub}` (account), `user:{sub}:notes` (owner's note ids, newest first), `history:{sub}` (view history, max 100), `folders:{sub}`.
```

API table: change the `GET /api/files/:id` row purpose to `Get file content; anonymous OK for 'link' notes (unprotected)`; add `| PATCH | \`/api/files/:id/visibility\` | Set 'private' or 'link' (owner only) |`.

Key Patterns: add

```
- Ownership: every write route checks `meta.ownerId === user.id` and answers 404 (never 403). `canRead()`: `link` → anyone, `private` → owner, legacy meta without `ownerId` → any authenticated user until `pnpm migrate:owner` has run.
- Listing a user's notes reads `user:{sub}:notes` then `getMetaMany`; never a `meta:` prefix scan (eventually consistent). Only the retention cron scans.
```

- [ ] **Step 2: `docs/DEPLOYMENT.md`** — insert after the Access application section:

````markdown
### 3. Migrate existing notes to your account (one-time)

After the first deploy with per-user storage, sign in once, then stamp every pre-existing note to your Access identity and move the old global history/folders:

```bash
pnpm exec wrangler kv key list --binding HISTORY --remote --prefix user:
```
````

Copy the id after `user:` (your Access `sub`), then:

```bash
pnpm migrate:owner <your-sub>
```

Idempotent; prints `{ stamped, skipped, indexed, movedHistory, movedFolders }`. Existing notes become `link`-visible (today's behaviour); new notes default to `private`. Until this runs, old notes are readable by any signed-in user and editable by nobody.

````

Renumber the following headings.

- [ ] **Step 3: Gate + commit**

```bash
git add CLAUDE.md docs/DEPLOYMENT.md
git commit -m "docs: per-user storage schema and owner migration runbook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
````

---

## After the plan

- PR to `main`. Merge deploys. Immediately after deploy: `pnpm migrate:owner <sub>` (Task 6 runbook). Between deploy and migration, existing notes are readable by the signed-in owner (legacy rule) and shared links to old notes 404 for anonymous visitors.
- Step 3 (edit + revisions + diff) builds on `currentNote.owned` and `meta.currentRev`.
