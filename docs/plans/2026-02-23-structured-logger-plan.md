# Structured Logger Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a structured JSON logger with configurable levels and integrate it across all worker routes and the cron handler.

**Architecture:** A standalone `src/logger.js` module exports `createLogger(level)`. A Hono middleware creates the logger per-request and logs request summaries. Route handlers use `c.get('logger')` for event-specific logging. The cron handler creates its own logger instance.

**Tech Stack:** Vanilla JS (ES modules), Hono middleware, Cloudflare Workers `console.*` API

**Design doc:** `docs/plans/2026-02-23-structured-logger-design.md`

---

### Task 1: Create logger module

**Files:**
- Create: `src/logger.js`

**Step 1: Create `src/logger.js` with the `createLogger` factory**

```js
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(level) {
  const threshold = LEVELS[(level || 'info').toLowerCase()] ?? LEVELS.info;

  function emit(lvl, msg, ctx) {
    if (LEVELS[lvl] < threshold) return;
    const entry = { level: lvl, msg, ...ctx, ts: new Date().toISOString() };
    console[lvl](JSON.stringify(entry));
  }

  return {
    debug: (msg, ctx) => emit('debug', msg, ctx),
    info: (msg, ctx) => emit('info', msg, ctx),
    warn: (msg, ctx) => emit('warn', msg, ctx),
    error: (msg, ctx) => emit('error', msg, ctx),
  };
}
```

**Step 2: Commit**

```bash
git add src/logger.js
git commit -m "feat(logger): add structured logger module with configurable levels"
```

---

### Task 2: Add request logging middleware

**Files:**
- Modify: `src/worker.js:1-4` (add import)
- Modify: `src/worker.js:154-166` (insert middleware before auth middleware)

**Step 1: Add import at top of `src/worker.js`**

Add after the existing hono/cookie import:

```js
import { createLogger } from './logger.js';
```

**Step 2: Add logging middleware BEFORE the auth middleware**

Insert before the `// ── Auth middleware` section (line 154). This middleware runs on ALL `/api/*` routes:

```js
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
```

**Step 3: Verify dev server starts**

Run: `pnpm dev` — confirm no import errors, server binds to port 8787.

**Step 4: Commit**

```bash
git add src/worker.js
git commit -m "feat(logger): add request logging middleware"
```

---

### Task 3: Add auth event logging

**Files:**
- Modify: `src/worker.js` — auth middleware (line ~156) and auth routes (lines ~170-195)

**Step 1: Add `auth.unauthorized` log to auth middleware**

In the existing auth middleware, before the `return c.json({ error: 'Unauthorized' }, 401)` line, add:

```js
    const log = c.get('logger');
    log.warn('auth.unauthorized', { path });
```

**Step 2: Add `auth.failure` and `auth.login` logs to login route**

In `POST /api/auth/login`, after the password check failure:
```js
    const log = c.get('logger');
    log.warn('auth.failure', { reason: 'invalid_password' });
```

After successful cookie set (before `return c.json({ success: true })`):
```js
  const log = c.get('logger');
  log.info('auth.login');
```

**Step 3: Add `auth.logout` log to logout route**

In `POST /api/auth/logout`, before the return:
```js
  const log = c.get('logger');
  log.info('auth.logout');
```

**Step 4: Commit**

```bash
git add src/worker.js
git commit -m "feat(logger): add auth event logging"
```

---

### Task 4: Add file operation event logging

**Files:**
- Modify: `src/worker.js` — upload, paste, file content, rename, delete routes

**Step 1: Add `file.upload` log**

In `POST /api/upload`, after `addHistoryEntry` and before the return:
```js
  const log = c.get('logger');
  log.info('file.upload', { fileId: id, filename: originalName, size: content.length });
```

**Step 2: Add `file.paste` log**

In `POST /api/paste`, after `addHistoryEntry` and before the return:
```js
  const log = c.get('logger');
  log.info('file.paste', { fileId: id, filename: displayName, size: content.length });
```

**Step 3: Add `file.fetch` and `file.notFound` logs**

In `GET /api/files/:id`:
- After the `if (!object)` check, before the 404 return:
  ```js
    const log = c.get('logger');
    log.warn('file.notFound', { fileId: id });
  ```
- After `addHistoryEntry` and before the success return:
  ```js
  const log = c.get('logger');
  log.debug('file.fetch', { fileId: id });
  ```

**Step 4: Add `file.rename` and `file.notFound` logs**

In `PATCH /api/files/:id`:
- After the `if (!metaJson)` 404 check, before the return:
  ```js
    const log = c.get('logger');
    log.warn('file.notFound', { fileId: id });
  ```
- After `writeHistory` and before the success return:
  ```js
  const log = c.get('logger');
  log.info('file.rename', { fileId: id, filename: trimmed });
  ```

**Step 5: Add `file.delete` log**

In `DELETE /api/files/:id`, before the success return:
```js
  const log = c.get('logger');
  log.info('file.delete', { fileId: id });
```

**Step 6: Commit**

```bash
git add src/worker.js
git commit -m "feat(logger): add file operation event logging"
```

---

### Task 5: Add history and folder event logging

**Files:**
- Modify: `src/worker.js` — history and folder routes

**Step 1: Add `history.clear` log**

In `DELETE /api/history`, before the return:
```js
  const log = c.get('logger');
  log.info('history.clear');
```

**Step 2: Add `history.remove` log**

In `DELETE /api/history/:id`, before the return:
```js
  const log = c.get('logger');
  log.info('history.remove', { entryId: id });
```

**Step 3: Add `folder.create` log**

In `POST /api/folders`, after `writeFolders` and before the return:
```js
  const log = c.get('logger');
  log.info('folder.create', { folderId: folder.id, name: folder.name });
```

**Step 4: Add `folder.delete` log**

In `DELETE /api/folders/:id`, before the success return:
```js
  const log = c.get('logger');
  log.info('folder.delete', { folderId: id, fileCount: folder.fileIds.length });
```

**Step 5: Commit**

```bash
git add src/worker.js
git commit -m "feat(logger): add history and folder event logging"
```

---

### Task 6: Add retention cron logging

**Files:**
- Modify: `src/worker.js` — `runRetention` function (lines ~115-152) and `scheduled` export (lines ~562-564)

**Step 1: Add logger to `runRetention` function**

Change `runRetention(env)` signature to `runRetention(env, log)`. Add tracking for archived count. At the end of the function, log the results:

```js
async function runRetention(env, log) {
  // ... existing code, but add:
  let archivedCount = 0;
  // In the archive branch, after kv.put: archivedCount++
  // At end of function:
  log.info('retention.run', { archived: archivedCount, deleted: deletedIds.length });
}
```

**Step 2: Wrap `scheduled` handler with try/catch and logger**

```js
async scheduled(event, env, ctx) {
  const log = createLogger(env.LOG_LEVEL);
  ctx.waitUntil(
    runRetention(env, log).catch((err) => {
      log.error('retention.error', { error: err.message });
    })
  );
},
```

**Step 3: Verify dev server starts**

Run: `pnpm dev` — confirm no errors.

**Step 4: Commit**

```bash
git add src/worker.js
git commit -m "feat(logger): add retention cron event logging"
```

---

### Task 7: Smoke test end-to-end

**Step 1: Start dev server**

Run: `pnpm dev`

**Step 2: Test login (should see `auth.login` + `request` logs in terminal)**

```bash
curl -s -c cookies.txt -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"<your-dev-password>"}'
```

Verify terminal output contains JSON lines with `"msg":"auth.login"` and `"msg":"request"`.

**Step 3: Test failed login (should see `auth.failure` + `request` at warn)**

```bash
curl -s -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"wrong"}'
```

Verify terminal shows `"msg":"auth.failure"` at warn level.

**Step 4: Test file paste (should see `file.paste` log)**

```bash
curl -s -b cookies.txt -X POST http://localhost:8787/api/paste \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Hello","title":"test.md"}'
```

Verify `"msg":"file.paste"` appears with `fileId`, `filename`, `size` fields.

**Step 5: Test unauthorized request (should see `auth.unauthorized`)**

```bash
curl -s -X GET http://localhost:8787/api/files
```

Verify `"msg":"auth.unauthorized"` at warn level.

**Step 6: Clean up, commit if any fixes needed**

---

### Task 8: Add LOG_LEVEL to dev vars

**Files:**
- Modify: `.dev.vars` (add `LOG_LEVEL=debug` for local development)

**Step 1: Add LOG_LEVEL to `.dev.vars`**

Append to `.dev.vars`:
```
LOG_LEVEL=debug
```

Note: `.dev.vars` is gitignored — this is local dev config only. For production, set via `wrangler secret put LOG_LEVEL` or leave unset (defaults to `info`).

**Step 2: Final commit — no code changes expected, just verify everything works**

Restart `pnpm dev` and confirm debug-level logs (like `file.fetch`) now appear.
