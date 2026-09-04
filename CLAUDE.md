# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

md-file-viewer is a Cloudflare Access-gated Markdown file viewer running on Cloudflare Workers. Users can upload `.md` files or paste markdown text, which gets stored in R2 and rendered client-side with markdown-it + highlight.js.

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Local dev server on port 8787 (emulates R2/KV locally)
pnpm run deploy       # Deploy to Cloudflare Workers (CI only — never run manually)
pnpm lint             # eslint
pnpm format:check     # prettier
pnpm typecheck        # tsc --checkJs over src/ (jsconfig.json)
pnpm test             # vitest: unit + workers-pool integration
pnpm uat              # detached wrangler dev + seed for agent-driven UAT (see .claude/skills/verifier-web)
pnpm uat:stop
```

Pre-commit hook (husky + lint-staged) runs eslint --fix + prettier on staged files.

## Architecture

**Backend:** Single Hono app in `src/worker.js` — all API routes in one file. Runs as a Cloudflare Worker.

**Frontend:** Vanilla JS SPA in `public/` — no build step, no bundler. Static assets served via Workers Static Assets from the `public/` directory.

- `public/index.html` — full HTML structure (login screen + app screen, toggled via `hidden` attribute)
- `public/js/app.js` — all client logic (auth, file upload, paste, history, markdown rendering)
- `public/css/style.css` — CSS custom properties for light/dark theming

**Storage bindings** (configured in `wrangler.jsonc`):

- `MD_FILES` — R2 bucket, stores raw markdown as `{uuid}.md`
- `HISTORY` — KV namespace, stores `history` (JSON array, max 100 entries) and `meta:{uuid}` (per-file metadata)

**Auth:** Cloudflare Access (Zero Trust) gates only `/api/auth/login`. Every `/api/*` request runs `resolveUser()` which verifies the `CF_Authorization` cookie (or `Cf-Access-Jwt-Assertion` header) via `src/auth.js` against `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` (wrangler vars, not secrets) and sets `c.get('user')` to `{ id, email }` or `null`. Routes outside `/api/auth/*` 401 without a user. Design: `docs/plans/2026-09-04-auth-design.md`.

**UAT stub:** `isDevEnv(env)` in `src/worker.js` is true only when `AUTH_STUB_USER` is set AND `ENVIRONMENT !== 'production'`. Then auth is bypassed and `/api/dev/seed` + `/api/dev/retention` are mounted; otherwise `/api/dev/*` is a 404 before auth. Only `scripts/uat.mjs` sets the stub (via `wrangler dev --env uat --var`). Guardrail: `src/dev.integration.test.js`. When real auth lands, keep the stub short-circuit in front of the new verifier. Under the stub, `X-Dev-User: <id>` switches identity (integration tests use `asUser()` from `src/test-utils/app.js`); the header is ignored outside `isDevEnv`.

## API Routes

All routes are prefixed with `/api/`. Auth-protected unless noted:

| Method | Path                 | Purpose                                                |
| ------ | -------------------- | ------------------------------------------------------ |
| GET    | `/api/auth/login`    | Access-gated; upserts user, redirects (unprotected)    |
| GET    | `/api/auth/check`    | `{ authenticated, user }` (unprotected)                |
| POST   | `/api/auth/logout`   | Clears cookie, returns Access logout URL (unprotected) |
| POST   | `/api/upload`        | Upload `.md` file (multipart form)                     |
| POST   | `/api/paste`         | Save pasted markdown (JSON body)                       |
| GET    | `/api/files`         | List all files                                         |
| GET    | `/api/files/:id`     | Get file content                                       |
| PATCH  | `/api/files/:id`     | Rename file                                            |
| DELETE | `/api/files/:id`     | Delete file                                            |
| GET    | `/api/history`       | Get view history                                       |
| DELETE | `/api/history`       | Clear all history                                      |
| DELETE | `/api/history/:id`   | Remove single history entry                            |
| POST   | `/api/dev/seed`      | UAT only: reset + seed scenarios                       |
| POST   | `/api/dev/retention` | UAT only: run retention cron now                       |

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`): `ci` job (lint, format:check, typecheck, test) on PRs and pushes to `main`; `deploy` job runs `wrangler deploy` on push to `main` only after `ci` passes. Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets. Never deploy manually.

## Testing

`vitest.config.js` has two projects: `unit` (node, `src/**/*.test.js`) and `integration` (`@cloudflare/vitest-pool-workers`, `src/**/*.integration.test.js`, miniflare R2 `MD_FILES` + KV `HISTORY`, isolated storage off — every test calls `clearAll()` in `beforeEach`). Tests drive the Hono app directly via `worker.fetch(req, env, ctx)` with a stubbed `ASSETS` fetcher (`src/test-utils/app.js`), so they control the full env. Vitest is pinned to 3.x for pool-workers compat.

Agent-driven UAT: `pnpm uat` → `.claude/skills/verifier-web/SKILL.md`.

## Routing

**Server-side:** A catch-all Hono route at the bottom of `src/worker.js` matches note paths and serves `index.html` via the `ASSETS` binding — this is the SPA fallback so direct file links and browser refresh work. Note URLs are base36-encoded UUIDs (25 chars, `[0-9a-z]`, e.g. `/djmlk8rqmyfbvw0cfe0lkllww`); legacy full-UUID paths are also accepted. Other paths return 404. Storage keys (R2/KV) remain plain UUIDs — the encoding is URL-layer only.

**Client-side:** `public/js/app.js` uses `history.pushState` / `popstate` for navigation. Viewing a file pushes `/<base36-id>` to the URL (`uuidToShortId`/`shortIdToUuid` in `app.js`); going back pushes `/`. A legacy `/<uuid>` deep link is decoded and rewritten to the short form via `replaceState`. Functions that change views accept `{ updateUrl: false }` to prevent double-pushing during `popstate` events. On initial load after auth, `showApp()` checks for a deep-linked file ID in the URL path.

## Key Patterns

- Client-side markdown rendering using CDN-loaded markdown-it and highlight.js (not bundled)
- Theme switching via `data-theme` attribute on `<html>` with CSS custom properties
- Sidebar uses CSS `margin-left` transition on desktop, `transform: translateX` on mobile (<768px)
- History is capped at 100 entries, stored as a single KV value
- File metadata stored separately in KV (`meta:{uuid}`) from file content in R2
- SPA routing uses strict ID regexes (25-char base36 or legacy UUID) on both server and client — only valid file paths get the fallback
- Theme has three modes stored in `localStorage.theme`: `light`, `dark`, `device` (follows `prefers-color-scheme` live); `data-theme` on `<html>` always holds the resolved light/dark value
- Sidebar history is grouped under Today / Yesterday / This Week / Older headings based on `viewedAt`
- Wide tables are wrapped in `.table-wrapper` after render so they scroll horizontally within their own bounds
