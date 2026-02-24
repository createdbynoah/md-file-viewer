# Structured Logger Design

**Issue:** #14 — Add structured logger utility with levels and key event logging
**Date:** 2026-02-23

## Overview

Add a lightweight structured JSON logger for `src/worker.js` that provides configurable log levels and covers key server events. Logs go to `console.*` (captured by Workers Logs and `wrangler tail`).

## Logger Module (`src/logger.js`)

A `createLogger(level)` factory that returns an object with `debug`, `info`, `warn`, and `error` methods. Each method no-ops if below the configured threshold.

**Log levels:** `debug=0`, `info=1` (default), `warn=2`, `error=3`

**Output format:** Single JSON line per call via matching `console.*` method:

```json
{"level":"info","msg":"file.upload","fileId":"abc-123","size":4096,"ts":"2026-02-23T12:00:00Z"}
```

Fields: `level`, `msg` (event name), `ts` (ISO timestamp), plus event-specific fields from second argument.

**API:**

```js
const log = createLogger(env.LOG_LEVEL); // defaults to 'info'
log.info('file.upload', { fileId: id, size: content.length });
```

## Hono Request Middleware

Registered before the auth middleware:

1. Creates logger via `createLogger(c.env.LOG_LEVEL)`, stores on `c.set('logger', log)`
2. Records start time
3. Calls `await next()`
4. Logs request summary: method, path, status, duration (ms)
5. 401 responses logged at `warn`, all others at `info`

Route handlers access the logger via `c.get('logger')`.

For the cron handler, the logger is created directly: `const log = createLogger(env.LOG_LEVEL)`.

## Event Catalog

| Event | Level | Context Fields | Route |
|-------|-------|---------------|-------|
| `auth.login` | info | — | POST /api/auth/login (success) |
| `auth.failure` | warn | `reason` | POST /api/auth/login (bad password) |
| `auth.logout` | info | — | POST /api/auth/logout |
| `auth.unauthorized` | warn | `path` | Auth middleware (invalid cookie) |
| `file.upload` | info | `fileId`, `filename`, `size` | POST /api/upload |
| `file.paste` | info | `fileId`, `filename`, `size` | POST /api/paste |
| `file.fetch` | debug | `fileId` | GET /api/files/:id |
| `file.rename` | info | `fileId`, `filename` | PATCH /api/files/:id |
| `file.delete` | info | `fileId` | DELETE /api/files/:id |
| `file.notFound` | warn | `fileId` | GET/PATCH /api/files/:id (404) |
| `history.clear` | info | — | DELETE /api/history |
| `history.remove` | info | `entryId` | DELETE /api/history/:id |
| `folder.create` | info | `folderId`, `name` | POST /api/folders |
| `folder.delete` | info | `folderId`, `fileCount` | DELETE /api/folders/:id |
| `retention.run` | info | `archived`, `deleted` | Cron handler |
| `retention.error` | error | `error` | Cron handler (on failure) |

## Design Decisions

- **No request ID** — Workers already provides `cf-ray` header for request correlation
- **File fetches at debug level** — most frequent operation, would be noisy at info
- **Auth failures at warn** — security-relevant events deserve elevated visibility
- **No external dependencies** — plain `console.*` + `JSON.stringify`
- **Default level: info** — configurable via `LOG_LEVEL` env var
- **Sensitive data never logged** — passwords and cookie values are excluded from all log calls
