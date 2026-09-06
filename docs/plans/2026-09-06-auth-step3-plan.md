# Auth Step 3 — Edit, Revisions, Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners can edit a note in place; every save creates a revision with an optional message; anyone who can read the note can list revisions, view a snapshot, and see a line diff between two revisions.

**Architecture:** Backend stays in the single-file Hono app (`src/worker.js`). Current content stays at R2 `{uuid}.md`; each save also writes an immutable snapshot `{uuid}/r/{n}.md` and prepends `{ n, at, by, message, bytes }` to KV `rev:{uuid}` (cap 100, oldest snapshot deleted on overflow). Revision 0 is the pre-edit content, snapshotted lazily on the first edit. Deleting a note (route, folder delete, retention) purges its snapshots and log through one helper. Frontend: an in-place textarea editor and a revisions drawer; diffs are computed client-side with `jsdiff` loaded from cdnjs (same pattern as markdown-it/highlight.js).

**Tech Stack:** Cloudflare Workers, Hono 4, KV + R2, vitest 3 (workers pool), vanilla JS SPA, `jsdiff` 7.0.0 via `https://cdnjs.cloudflare.com/ajax/libs/jsdiff/7.0.0/diff.min.js` (global `Diff`).

**Spec:** `docs/plans/2026-09-04-auth-design.md` — "Data model" (`rev:{uuid}`, R2 `{uuid}/r/{n}.md`), "Authorization rules" (revisions rows), "Edit, change log, diffs", "Frontend" (Edit, History, edit mode, revisions drawer). Issues #71 #72 #73. Carried from step 2 review: spec's "Sidebar footer: email + Sign out" and a `popstate` guard for the anonymous read-only page.

## Global Constraints

- Edit is owner-only (`isOwner(meta, user)`); non-owners and anonymous get **404** on `PUT`, never 403.
- Revision reads follow `canRead(meta, user)`: `link` → anyone (incl. anonymous), `private` → owner, legacy → any authenticated user; otherwise 404.
- `PUT /api/files/:id` body `{ content: string, message?: string }`; 400 when `content` is not a non-empty string, equals the current content, or exceeds `MAX_NOTE_BYTES = 2 * 1024 * 1024`; `message` trimmed and capped at 200 chars. Rename never creates a revision.
- Revision log `rev:{uuid}` is newest first, cap **100**; on overflow drop the oldest entry and delete its R2 snapshot.
- Revision 0 = content as first uploaded/pasted, snapshotted to `{uuid}/r/0.md` on the first edit with `at = meta.created`, `message = 'Original'`.
- Anonymous surface becomes `/api/auth/*`, `GET /api/files/:id`, `GET /api/files/:id/revisions`, `GET /api/files/:id/revisions/:n` (all GET only).
- Diffing is client-side only. No server-side diff. No new runtime deps; `jsdiff` from the CDN like the other libs.
- `isDevEnv` semantics unchanged; `src/dev.integration.test.js` stays green at every commit.
- Every commit passes `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`. Prettier printWidth 100, singleQuote. Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File map

| File                                              | Responsibility                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/worker.js`                                   | `deleteNoteObjects`, revision helpers, `PUT`, two `GET …/revisions` routes, middleware allow-list, size cap. |
| `src/seed.js`                                     | "Code blocks" note gets two revisions so UAT can exercise the drawer.                                        |
| `src/revisions.integration.test.js`               | New: edit/revision/authorization/purge tests (two-user).                                                     |
| `public/index.html`, `js/app.js`, `css/style.css` | Edit mode, revisions drawer + diff, Sign out in footer, popstate guard.                                      |
| `CLAUDE.md`                                       | API table + patterns.                                                                                        |

---

### Task 1: Backend — revisions storage, `PUT`, revision reads, purge on delete

**Files:**

- Modify: `src/worker.js` — helpers after `touchMeta` (~line 76); middleware allow-list (~line 357); routes after `PATCH /api/files/:id/visibility` (~line 580); `DELETE /api/files/:id` (~594), `DELETE /api/folders/:id` (~736), `runRetention` (~296); `POST /api/upload`/`paste` size cap
- Modify: `src/seed.js`
- Test: `src/revisions.integration.test.js` (new)

**Interfaces (module-private in `src/worker.js`):**

- `MAX_NOTE_BYTES = 2 * 1024 * 1024`, `REVISIONS_MAX = 100`
- `revKey(id) → 'rev:' + id`, `snapshotKey(id, n) → \`${id}/r/${n}.md\``
- `readRevisions(kv, id) → Array<{ n, at, by, message, bytes }>` newest first
- `deleteNoteObjects(env, id)` — deletes `{id}.md`, every `{id}/r/*` object, `rev:{id}`
- Routes: `PUT /api/files/:id` → `{ id, currentRev, revision }`; `GET /api/files/:id/revisions` → array; `GET /api/files/:id/revisions/:n` → `text/markdown; charset=utf-8` body.
- `GET /api/files/:id` response gains `currentRev`.
- Seed returns `{ notes: 11, folders: 3, history: 6, revisions: 2 }`.

- [ ] **Step 1: Write the failing tests**

`src/revisions.integration.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  call,
  authed,
  json,
  devEnv,
  paste,
  clearAll,
  asUser,
  readJson,
  runScheduled,
} from './test-utils/app.js';

const alice = () => devEnv({ AUTH_STUB_USER: 'alice' });
const bob = { headers: asUser('bob') };
const put = (env, id, body, extra = {}) =>
  authed(`/api/files/${id}`, json(body, { method: 'PUT', ...extra }), env);
const share = (env, id) =>
  authed(`/api/files/${id}/visibility`, json({ visibility: 'link' }, { method: 'PATCH' }), env);

describe('revisions', () => {
  beforeEach(() => clearAll());

  it('first edit snapshots rev 0, writes rev 1, updates current content and meta', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    const res = await put(env, id, { content: 'v1', message: '  first  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      currentRev: 1,
      revision: { n: 1, by: 'alice@dev.local', message: 'first', bytes: 2 },
    });
    expect(await (await env.MD_FILES.get(`${id}.md`)).text()).toBe('v1');
    expect(await (await env.MD_FILES.get(`${id}/r/0.md`)).text()).toBe('v0');
    expect(await (await env.MD_FILES.get(`${id}/r/1.md`)).text()).toBe('v1');
    const meta = await readJson(env, `meta:${id}`);
    expect(meta).toMatchObject({ currentRev: 1, size: 2 });
    const revs = await readJson(env, `rev:${id}`);
    expect(revs.map((r) => r.n)).toEqual([1, 0]);
    expect(revs[1]).toMatchObject({ n: 0, message: 'Original', bytes: 2, at: meta.created });
    const file = await (await authed(`/api/files/${id}`, {}, env)).json();
    expect(file).toMatchObject({ content: 'v1', currentRev: 1 });
  });

  it('validates the body', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    expect((await put(env, id, { content: 'v0' })).status).toBe(400); // unchanged
    expect((await put(env, id, { content: '' })).status).toBe(400);
    expect((await put(env, id, { content: 42 })).status).toBe(400);
    expect((await put(env, id, { content: 'x'.repeat(2 * 1024 * 1024 + 1) })).status).toBe(400);
    const long = await put(env, id, { content: 'v1', message: 'm'.repeat(300) });
    expect((await long.json()).revision.message).toHaveLength(200);
    expect(await readJson(env, `rev:${id}`)).toHaveLength(2);
  });

  it('is owner-only: bob and anonymous get 404 and nothing changes', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    await share(env, id);
    expect((await put(env, id, { content: 'hack' }, bob)).status).toBe(404);
    expect(
      (await call(`/api/files/${id}`, json({ content: 'hack' }, { method: 'PUT' }))).status
    ).toBe(401);
    expect(await (await env.MD_FILES.get(`${id}.md`)).text()).toBe('v0');
    expect(await env.HISTORY.get(`rev:${id}`)).toBeNull();
  });

  it('lists and serves revisions under the read rules', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    await put(env, id, { content: 'v1' });
    await put(env, id, { content: 'v2', message: 'two' });

    // private: owner yes, bob/anon 404
    const mine = await (await authed(`/api/files/${id}/revisions`, {}, env)).json();
    expect(mine.map((r) => r.n)).toEqual([2, 1, 0]);
    expect((await authed(`/api/files/${id}/revisions`, bob, env)).status).toBe(404);
    expect((await call(`/api/files/${id}/revisions`)).status).toBe(404);
    expect((await call(`/api/files/${id}/revisions/1`)).status).toBe(404);

    await share(env, id);
    const anonList = await call(`/api/files/${id}/revisions`);
    expect(anonList.status).toBe(200);
    const snap = await call(`/api/files/${id}/revisions/1`);
    expect(snap.status).toBe(200);
    expect(snap.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(await snap.text()).toBe('v1');
    expect(await (await call(`/api/files/${id}/revisions/0`)).text()).toBe('v0');
    expect((await call(`/api/files/${id}/revisions/9`)).status).toBe(404);
    expect((await call(`/api/files/${id}/revisions/abc`)).status).toBe(404);
    // no edits yet → empty list, and rev 0 is not served until it exists
    const fresh = await paste('f', 'Fresh', env);
    await share(env, fresh);
    expect(await (await call(`/api/files/${fresh}/revisions`)).json()).toEqual([]);
    expect((await call(`/api/files/${fresh}/revisions/0`)).status).toBe(404);
  });

  it('caps the log at 100 and deletes the evicted snapshot', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    for (let i = 1; i <= 100; i++) await put(env, id, { content: `v${i}` });
    // entries: 100..1 plus 0 = 101 → oldest (0) evicted
    const revs = await readJson(env, `rev:${id}`);
    expect(revs).toHaveLength(100);
    expect(revs[0].n).toBe(100);
    expect(revs[99].n).toBe(1);
    expect(await env.MD_FILES.get(`${id}/r/0.md`)).toBeNull();
    expect(await env.MD_FILES.get(`${id}/r/1.md`)).not.toBeNull();
  }, 30000);

  it('rename does not create a revision', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    await authed(`/api/files/${id}`, json({ filename: 'Renamed' }, { method: 'PATCH' }), env);
    expect(await env.HISTORY.get(`rev:${id}`)).toBeNull();
    expect((await readJson(env, `meta:${id}`)).currentRev).toBe(0);
  });

  it('deleting a note purges snapshots and the log (route, folder delete, retention)', async () => {
    const env = alice();
    const a = await paste('a0', 'A', env);
    await put(env, a, { content: 'a1' });
    await authed(`/api/files/${a}`, { method: 'DELETE' }, env);
    expect(await env.MD_FILES.get(`${a}/r/0.md`)).toBeNull();
    expect(await env.MD_FILES.get(`${a}/r/1.md`)).toBeNull();
    expect(await env.HISTORY.get(`rev:${a}`)).toBeNull();

    const b = await paste('b0', 'B', env);
    await put(env, b, { content: 'b1' });
    const folder = await (await authed('/api/folders', json({ name: 'F' }), env)).json();
    await authed(`/api/folders/${folder.id}/files`, json({ fileId: b }), env);
    await authed(`/api/folders/${folder.id}`, { method: 'DELETE' }, env);
    expect(await env.MD_FILES.get(`${b}/r/1.md`)).toBeNull();
    expect(await env.HISTORY.get(`rev:${b}`)).toBeNull();

    const c = await paste('c0', 'C', env);
    await put(env, c, { content: 'c1' });
    const meta = await readJson(env, `meta:${c}`);
    meta.lastAccessedAt = new Date(Date.now() - 61 * 24 * 3600 * 1000).toISOString();
    await env.HISTORY.put(`meta:${c}`, JSON.stringify(meta));
    await runScheduled(env);
    expect(await env.MD_FILES.get(`${c}.md`)).toBeNull();
    expect(await env.MD_FILES.get(`${c}/r/1.md`)).toBeNull();
    expect(await env.HISTORY.get(`rev:${c}`)).toBeNull();
  });

  it('upload and paste reject content over the size cap', async () => {
    const env = alice();
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    expect((await authed('/api/paste', json({ content: big }), env)).status).toBe(400);
    const form = new FormData();
    form.append('file', new File([big], 'big.md', { type: 'text/markdown' }));
    expect((await authed('/api/upload', { method: 'POST', body: form }, env)).status).toBe(400);
  });
});
```

Also extend `src/dev.integration.test.js` `'uat + stub bypasses auth and exposes seed'`: change the seed expectation to `toMatchObject({ ok: true, notes: 11, folders: 3, revisions: 2 })` and append:

```js
const revs = await (await call(`/api/files/${SEED_IDS.code}/revisions`, {}, env)).json();
expect(revs.map((r) => r.n)).toEqual([2, 1, 0]);
```

(`SEED_IDS` is already imported dynamically in that test; reuse it.)

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run --project integration src/revisions.integration.test.js src/dev.integration.test.js`
Expected: FAIL — `PUT` 404 (no route), revisions routes 404/401, seed has no `revisions`.

- [ ] **Step 3: Implement in `src/worker.js`**

Constants near the top (after `HISTORY_MAX`):

```js
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const REVISIONS_MAX = 100;
const MESSAGE_MAX = 200;
```

Helpers after `touchMeta`:

```js
// ── Revisions ───────────────────────────────────────────────────────────────
// rev:{uuid} = [{ n, at, by, message, bytes }] newest first, cap REVISIONS_MAX.
// Snapshot n lives at R2 `{uuid}/r/{n}.md`; `{uuid}.md` is always the latest.

const revKey = (id) => `rev:${id}`;
const snapshotKey = (id, n) => `${id}/r/${n}.md`;

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
}

function cleanMessage(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MESSAGE_MAX);
}
```

Replace the three existing `await c.env.MD_FILES.delete(\`${id}.md\`)` / `${fid}.md`calls (route delete, folder delete, retention) with`await deleteNoteObjects(c.env, id)`/`(env, id)`/`(c.env, fid)`.

Size cap in `POST /api/upload` (after reading `content`) and `POST /api/paste` (after the type check):

```js
if (content.length > MAX_NOTE_BYTES) {
  return c.json({ error: 'Note too large (max 2 MB)' }, 400);
}
```

Middleware allow-list — replace the `PUBLIC_FILE_RE` line and its use:

```js
const PUBLIC_READ_RE = /^\/api\/files\/[^/]+(\/revisions(\/[^/]+)?)?$/;
…
  if (c.req.method === 'GET' && PUBLIC_READ_RE.test(path)) return next();
```

`GET /api/files/:id` response: add `currentRev: meta.currentRev || 0`.

New routes after the visibility route:

```js
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
  const current = currentObj ? await currentObj.text() : '';
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
  if (!meta || !canRead(meta, c.get('user'))) {
    return c.json({ error: 'File not found' }, 404);
  }
  return c.json(await readRevisions(c.env.HISTORY, id));
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
```

Route order: `PUT /api/files/:id` is a distinct method so it cannot shadow the `PATCH` routes; `GET /api/files/:id/revisions` and `/:n` are two/three segments, so `GET /api/files/:id` never matches them.

`src/seed.js`: after writing notes, add two revisions to `SEED_IDS.code`:

```js
// Revisions for the drawer/diff UAT: original + two edits on "Code blocks".
const codeV1 = CODE.replace('Inline `code` too.', 'Inline `code` too. Edited once.');
const codeV2 = codeV1 + '\nSecond edit appends a line.\n';
await env.MD_FILES.put(`${SEED_IDS.code}/r/0.md`, CODE);
await env.MD_FILES.put(`${SEED_IDS.code}/r/1.md`, codeV1);
await env.MD_FILES.put(`${SEED_IDS.code}/r/2.md`, codeV2);
await env.MD_FILES.put(`${SEED_IDS.code}.md`, codeV2);
await env.HISTORY.put(
  `rev:${SEED_IDS.code}`,
  JSON.stringify([
    { n: 2, at: ago(1), by: `${OWNER}@dev.local`, message: 'Append a line', bytes: codeV2.length },
    {
      n: 1,
      at: ago(1.5),
      by: `${OWNER}@dev.local`,
      message: 'Tweak inline code',
      bytes: codeV1.length,
    },
    { n: 0, at: ago(2), by: `${OWNER}@dev.local`, message: 'Original', bytes: CODE.length },
  ])
);
```

and set that note's meta `currentRev: 2`, `size: codeV2.length` (pass through `note()` options or patch the meta object before writing). Return `{ notes, folders, history, revisions: 2 }`.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test` — expected PASS. The 100-edit test takes a few seconds; keep its 30 s timeout.

- [ ] **Step 5: Gate + commit**

```bash
git add src/worker.js src/seed.js src/revisions.integration.test.js src/dev.integration.test.js
git commit -m "feat(worker): edit notes with revision snapshots, log, and diff-ready reads

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Frontend — edit mode, Sign out in footer, popstate guard

**Files:**

- Modify: `public/index.html` (viewer toolbar ~214–225; viewer-scroll; sidebar footer ~179; topbar logout ~127)
- Modify: `public/js/app.js` (element refs; `applyOwnerControls` ~963; `viewFile` ~932; `showInputArea` ~1045; `popstate` ~295; logout handler ~388)
- Modify: `public/css/style.css`

**Interfaces:**

- Consumes: `PUT /api/files/:id` → `{ id, currentRev, revision }`; `GET /api/files/:id` → `currentRev`.
- Produces: `currentNote = { id, owned, visibility, currentRev }`; `enterEditMode()`, `exitEditMode()`, `saveEdit()`; `#history-btn` exists (hidden until Task 3 wires it).

- [ ] **Step 1: Markup**

Toolbar: add before `#visibility-btn`:

```html
<button id="edit-btn" class="text-btn" hidden>Edit</button>
<button id="history-btn" class="text-btn" hidden>History</button>
```

Inside `.viewer-scroll`, before `#rendered-output`:

```html
<div id="editor-area" class="editor-area" hidden>
  <textarea id="editor-input" class="editor-input" spellcheck="false"></textarea>
  <div class="editor-bar">
    <input
      id="editor-message"
      class="editor-message"
      type="text"
      maxlength="200"
      placeholder="What changed? (optional)"
    />
    <button id="editor-preview-btn" class="text-btn">Preview</button>
    <button id="editor-cancel-btn" class="text-btn">Cancel</button>
    <button id="editor-save-btn" class="primary-btn">Save</button>
  </div>
</div>
```

Sidebar footer → move Sign out here (spec): replace the footer with

```html
<div class="sidebar-footer">
  <span id="user-email" class="user-email"></span>
  <button id="logout-btn" class="text-btn" aria-label="Sign out">Sign out</button>
</div>
```

and delete the topbar `<button id="logout-btn" …>…</button>` (keep `#topbar-signin`). `logoutBtn` JS ref keeps working (same id).

- [ ] **Step 2: CSS** — append:

```css
.sidebar-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.user-email {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 0;
}
.editor-input {
  width: 100%;
  min-height: 60vh;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9rem;
  line-height: 1.5;
  resize: vertical;
}
.editor-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.editor-message {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
}
```

Merge the `display:flex` additions into the existing `.sidebar-footer` rule (don't duplicate the selector).

- [ ] **Step 3: JS**

Refs:

```js
const editBtn = document.getElementById('edit-btn');
const historyBtn = document.getElementById('history-btn');
const editorArea = document.getElementById('editor-area');
const editorInput = document.getElementById('editor-input');
const editorMessage = document.getElementById('editor-message');
const editorPreviewBtn = document.getElementById('editor-preview-btn');
const editorCancelBtn = document.getElementById('editor-cancel-btn');
const editorSaveBtn = document.getElementById('editor-save-btn');
let editing = false;
```

`viewFile`: `currentNote = { id, owned: …, visibility: …, currentRev: data.currentRev || 0 };` and `tryLoadPublicFile` likewise (`currentRev: data.currentRev || 0`).

`applyOwnerControls`: add `editBtn.hidden = !owned || editing;` and `historyBtn.hidden = !currentNote;` (drawer wired in Task 3; button visible to anyone who can read).

Edit mode:

```js
function enterEditMode() {
  if (!currentNote || !currentNote.owned || currentRawMarkdown == null) return;
  editing = true;
  editorInput.value = currentRawMarkdown;
  editorMessage.value = '';
  renderedOutput.hidden = true;
  editorArea.hidden = false;
  editorPreviewBtn.textContent = 'Preview';
  applyOwnerControls();
  editorInput.focus();
}

function exitEditMode() {
  editing = false;
  editorArea.hidden = true;
  renderedOutput.hidden = false;
  applyOwnerControls();
}

async function saveEdit() {
  if (!editing || !currentNote) return;
  const content = editorInput.value;
  if (content === currentRawMarkdown) {
    exitEditMode();
    return;
  }
  editorSaveBtn.disabled = true;
  try {
    const res = await api(`/api/files/${encodeURIComponent(currentNote.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ content, message: editorMessage.value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Save failed');
      return;
    }
    const data = await res.json();
    currentRawMarkdown = content;
    currentNote.currentRev = data.currentRev;
    renderMarkdown(content, currentFilename, currentNote.id);
    exitEditMode();
    syncSidebar('file-edit');
  } catch {
    /* api() already redirected on 401 */
  } finally {
    editorSaveBtn.disabled = false;
  }
}

editBtn.addEventListener('click', enterEditMode);
editorCancelBtn.addEventListener('click', exitEditMode);
editorSaveBtn.addEventListener('click', saveEdit);
editorPreviewBtn.addEventListener('click', () => {
  // Toggle between textarea and a live render of the draft.
  const showingPreview = !renderedOutput.hidden;
  if (showingPreview) {
    renderedOutput.hidden = true;
    editorInput.hidden = false;
    editorPreviewBtn.textContent = 'Preview';
  } else {
    renderedOutput.innerHTML = md.render(editorInput.value);
    addCodeCopyButtons();
    wrapTables();
    renderedOutput.hidden = false;
    editorInput.hidden = true;
    editorPreviewBtn.textContent = 'Edit';
  }
});
editorInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveEdit();
  }
});
```

`exitEditMode` must also reset `editorInput.hidden = false` and re-render the saved/original content (`renderMarkdown(currentRawMarkdown, currentFilename, currentNote.owned ? currentNote.id : null)`) so a cancelled preview does not leave the draft on screen. `showInputArea` and `viewFile` call `exitEditMode()` first if `editing` (discard draft). `renderMarkdown` must not reset `editorArea` visibility — check it only touches `renderedOutput`/title.

`popstate` guard:

```js
window.addEventListener('popstate', () => {
  if (document.body.classList.contains('read-only')) {
    // Anonymous read-only page: any in-app navigation needs a sign-in.
    location.reload();
    return;
  }
  …existing body…
});
```

Logout handler: unchanged (same element id). `showApp()` still sets `logoutBtn.hidden = false`; `tryLoadPublicFile` sets it hidden — with the footer inside the hidden sidebar that is redundant but harmless; keep.

- [ ] **Step 4: Browser verification** (`pnpm uat`)

1. Sidebar footer shows email + Sign out; topbar has no logout icon.
2. Open "Short note": Edit visible; click → textarea with content, message field. Type a change, Preview toggles rendered draft and back, Cmd/Ctrl+S saves → rendered view updates, no reload; reopen note → content persisted. Cancel discards.
3. Save with no changes → exits edit mode, no request (network tab).
4. Open `other_user`'s link note: no Edit button; History button present.
   Screenshots to the report dir. `pnpm uat:stop`.

- [ ] **Step 5: Gate + commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(frontend): in-place editor with preview and Cmd+S; Sign out in sidebar footer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — revisions drawer + diff

**Files:**

- Modify: `public/index.html` (script tag for jsdiff; drawer markup inside `#viewer-area`)
- Modify: `public/js/app.js`
- Modify: `public/css/style.css`

**Interfaces:**

- Consumes: `GET /api/files/:id/revisions` → `[{ n, at, by, message, bytes }]` newest first; `GET /api/files/:id/revisions/:n` → markdown text; global `Diff` from jsdiff (`Diff.diffLines(oldStr, newStr)` → `[{ value, added?, removed? }]`).
- Produces: `openRevisions()`, `closeRevisions()`, `showDiff(fromN, toN)`.

- [ ] **Step 1: Markup + script**

Add before `/js/app.js` in `index.html`:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/jsdiff/7.0.0/diff.min.js"></script>
```

(Verified 200 on 2026-09-06.) Inside `#viewer-area`, after `.viewer-toolbar`:

```html
<aside id="revisions-drawer" class="revisions-drawer" hidden>
  <div class="revisions-header">
    <strong>History</strong>
    <label
      >From
      <select id="rev-from"></select
    ></label>
    <label
      >To
      <select id="rev-to"></select
    ></label>
    <button id="rev-view-btn" class="text-btn">View "To"</button>
    <button id="revisions-close-btn" class="text-btn">Close</button>
  </div>
  <ul id="revisions-list" class="revisions-list"></ul>
  <pre id="rev-diff" class="rev-diff"></pre>
</aside>
```

- [ ] **Step 2: CSS** — append:

```css
.revisions-drawer {
  border-bottom: 1px solid var(--border-light);
  padding: 12px 24px;
  max-height: 45vh;
  overflow: auto;
  background: var(--bg-secondary);
}
.revisions-header {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.revisions-list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  font-size: 0.85rem;
}
.revisions-list li {
  display: flex;
  gap: 10px;
  padding: 4px 0;
  cursor: pointer;
}
.revisions-list li.active {
  font-weight: 600;
}
.rev-diff {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.4;
  white-space: pre-wrap;
}
.rev-diff .add {
  background: color-mix(in srgb, #2ea043 20%, transparent);
}
.rev-diff .del {
  background: color-mix(in srgb, #f85149 20%, transparent);
  text-decoration: line-through;
}
```

If `--bg-secondary` does not exist, use the token the sidebar background uses (check `.sidebar`).

- [ ] **Step 3: JS**

```js
const revisionsDrawer = document.getElementById('revisions-drawer');
const revisionsList = document.getElementById('revisions-list');
const revFrom = document.getElementById('rev-from');
const revTo = document.getElementById('rev-to');
const revViewBtn = document.getElementById('rev-view-btn');
const revDiff = document.getElementById('rev-diff');
const revisionsCloseBtn = document.getElementById('revisions-close-btn');
let revisions = [];
const snapshotCache = new Map(); // `${id}:${n}` → text

async function fetchSnapshot(id, n) {
  const key = `${id}:${n}`;
  if (snapshotCache.has(key)) return snapshotCache.get(key);
  const res = await fetch(`/api/files/${encodeURIComponent(id)}/revisions/${n}`);
  if (!res.ok) throw new Error('snapshot');
  const text = await res.text();
  snapshotCache.set(key, text);
  return text;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  );
}

async function openRevisions() {
  if (!currentNote) return;
  const res = await fetch(`/api/files/${encodeURIComponent(currentNote.id)}/revisions`);
  if (!res.ok) return;
  revisions = await res.json();
  revisionsList.innerHTML = '';
  revFrom.innerHTML = '';
  revTo.innerHTML = '';
  if (revisions.length === 0) {
    revisionsList.innerHTML = '<li>No edits yet.</li>';
    revDiff.textContent = '';
    revisionsDrawer.hidden = false;
    return;
  }
  for (const r of revisions) {
    const li = document.createElement('li');
    li.dataset.n = String(r.n);
    li.innerHTML = `<span>#${r.n}</span><span>${fmtWhen(r.at)}</span><span>${escapeHtml(r.by)}</span><span>${escapeHtml(r.message || '')}</span><span>${r.bytes} B</span>`;
    li.addEventListener('click', () => {
      const idx = revisions.findIndex((x) => x.n === r.n);
      const prev = revisions[idx + 1];
      showDiff(prev ? prev.n : r.n, r.n);
    });
    revisionsList.appendChild(li);
    for (const sel of [revFrom, revTo]) {
      const opt = document.createElement('option');
      opt.value = String(r.n);
      opt.textContent = `#${r.n}`;
      sel.appendChild(opt);
    }
  }
  revisionsDrawer.hidden = false;
  const latest = revisions[0].n;
  const prev = revisions[1] ? revisions[1].n : latest;
  showDiff(prev, latest);
}

function closeRevisions() {
  revisionsDrawer.hidden = true;
}

async function showDiff(fromN, toN) {
  revFrom.value = String(fromN);
  revTo.value = String(toN);
  for (const li of revisionsList.children)
    li.classList.toggle('active', li.dataset.n === String(toN));
  try {
    const [a, b] = await Promise.all([
      fetchSnapshot(currentNote.id, fromN),
      fetchSnapshot(currentNote.id, toN),
    ]);
    revDiff.innerHTML = '';
    if (fromN === toN) {
      revDiff.textContent = '(same revision)';
      return;
    }
    for (const part of Diff.diffLines(a, b)) {
      const span = document.createElement('span');
      span.className = part.added ? 'add' : part.removed ? 'del' : '';
      span.textContent = part.value;
      revDiff.appendChild(span);
    }
  } catch {
    revDiff.textContent = 'Could not load revisions.';
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

historyBtn.addEventListener('click', () => {
  if (revisionsDrawer.hidden) openRevisions();
  else closeRevisions();
});
revisionsCloseBtn.addEventListener('click', closeRevisions);
revFrom.addEventListener('change', () => showDiff(Number(revFrom.value), Number(revTo.value)));
revTo.addEventListener('change', () => showDiff(Number(revFrom.value), Number(revTo.value)));
revViewBtn.addEventListener('click', async () => {
  // Render the "To" snapshot read-only in the main article (does not change the note).
  const n = Number(revTo.value);
  const text = await fetchSnapshot(currentNote.id, n);
  renderedOutput.innerHTML = md.render(text);
  addCodeCopyButtons();
  wrapTables();
  viewerTitle.textContent = `${currentFilename} — revision #${n}`;
});
```

Reset on navigation: `viewFile`, `tryLoadPublicFile`, and `showInputArea` call `closeRevisions()`; `saveEdit` calls `closeRevisions()` and invalidates `snapshotCache` entries for that id (or just `snapshotCache.clear()`). `applyOwnerControls`: `historyBtn.hidden = !currentNote;` (already from Task 2). Anonymous read-only page: the drawer works because both fetches are plain `fetch`.

- [ ] **Step 4: Browser verification** (`pnpm uat`)

1. Open "Code blocks" (seeded with 3 revisions): History → drawer lists #2 #1 #0, diff #1→#2 shown with the appended line highlighted; click #1 → diff #0→#1 shows the inline-code change; From/To selects work; View "To" renders the snapshot with the title suffix; Close.
2. Edit the note, save → History shows #3 on top.
3. "Short note" (no edits): drawer says "No edits yet."
4. `pnpm dev` anonymous on a link note's URL: History works read-only (no 401 bounce). Use the UAT store's shared note id if `pnpm dev` shares the local store (it did in step 2); otherwise describe what was checked.
   Screenshots to the report dir. Stop servers.

- [ ] **Step 5: Gate + commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(frontend): revisions drawer with line diffs (jsdiff)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Docs

**Files:** `CLAUDE.md`, `.claude/skills/verifier-web/SKILL.md` (seed table row for "Code blocks" revisions)

- [ ] **Step 1: `CLAUDE.md`** — API table add:

```
| PUT    | `/api/files/:id`                  | Edit content; creates a revision (owner only)              |
| GET    | `/api/files/:id/revisions`        | Revision log, newest first (same read rules; unprotected) |
| GET    | `/api/files/:id/revisions/:n`     | Raw markdown snapshot (same read rules; unprotected)       |
```

Storage bindings: add `rev:{uuid}` (revision log, cap 100) to the `HISTORY` line; R2 line: `{uuid}.md` current + `{uuid}/r/{n}.md` snapshots. Key Patterns: add "Revisions: `PUT` snapshots rev 0 lazily on first edit; cap 100 with oldest snapshot deleted; `deleteNoteObjects()` is the only way a note's objects are removed. Diffs are client-side (`jsdiff` CDN). Note size cap 2 MB."

- [ ] **Step 2: verifier-web SKILL.md** — in the seed scenario table, note "Code blocks" has revisions #0–#2 for the History drawer.

- [ ] **Step 3: Gate + commit**

```bash
git add CLAUDE.md .claude/skills/verifier-web/SKILL.md
git commit -m "docs: revisions API, storage keys, UAT seed note

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## After the plan

PR to `main`; merge deploys. No migration needed (existing notes have `currentRev: 0` from the step 2 migration; their revision log starts on first edit). Closes #71 #72 #73 and the epic #28.
