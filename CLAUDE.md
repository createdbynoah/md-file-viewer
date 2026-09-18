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
- `public/js/app.js` — all client logic (auth, file upload, paste, history, markdown rendering); loaded as an ES module
- `public/js/scroll-memory.js` — pure per-note scroll-position helpers (unit-tested)
- `public/js/header-autohide.js` — pure show/hide decision for the sticky note toolbar (unit-tested)
- `public/js/anchor.js` — pure source-quote anchoring (capture/locate); also imported by the worker (unit-tested)
- `public/js/feedback-format.js` — pure agent-feedback text generator (unit-tested)
- `public/js/source-lines.js` — markdown-it plugin stamping `data-line` on blocks (unit-tested)
- `public/js/review-layout.js` — pure layout/keyboard-inset/summary helpers for review mode (unit-tested)
- `public/js/comments-composer.js` — the comment composer's DOM builder (tag chips, note, Save/Cancel; unit-tested)
- `public/js/comments-cards.js` — comment card DOM builders for the rail, drawer, list sheet, and item view (unit-tested)
- `public/js/el.js` — tiny DOM-builder helper
- `public/js/comments-ui.js` — review mode controller: anchoring, highlights, and presentation per layout (rail ≥1024, drawer 768–1023, bottom sheets <768)
- `public/css/style.css` — CSS custom properties for light/dark theming

**Storage bindings** (configured in `wrangler.jsonc`):

- `MD_FILES` — R2 bucket, stores raw markdown as `{uuid}.md` (current) plus `{uuid}/r/{n}.md` revision snapshots
- `HISTORY` — KV namespace: `meta:{uuid}` (per-file metadata incl. `ownerId`, `visibility: 'private'|'link'`, `editors`, `currentRev`), `rev:{uuid}` (revision log, newest first, cap 100), `user:{sub}` (account), `user:{sub}:notes` (owner's note ids, newest first), `history:{sub}` (view history, max 100), `folders:{sub}`, `comments:{uuid}` (owner's review comments `{ nextId, round, items }`, cap 500)

**Auth:** Cloudflare Access (Zero Trust) gates only `/api/auth/login`. Every `/api/*` request runs `resolveUser()` which verifies the `CF_Authorization` cookie (or `Cf-Access-Jwt-Assertion` header) via `src/auth.js` against `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` (wrangler vars, not secrets) and sets `c.get('user')` to `{ id, email }` or `null`. Routes outside `/api/auth/*` 401 without a user. Design: `docs/plans/2026-09-04-auth-design.md`.

**UAT stub:** `isDevEnv(env)` in `src/worker.js` is true only when `AUTH_STUB_USER` is set AND `ENVIRONMENT !== 'production'`. Then auth is bypassed and `/api/dev/seed` + `/api/dev/retention` are mounted; otherwise `/api/dev/*` is a 404 before auth. Only `scripts/uat.mjs` sets the stub (via `wrangler dev --env uat --var`). Guardrail: `src/dev.integration.test.js`. When real auth lands, keep the stub short-circuit in front of the new verifier. Under the stub, `X-Dev-User: <id>` switches identity (integration tests use `asUser()` from `src/test-utils/app.js`); the header is ignored outside `isDevEnv`.

## API Routes

All routes are prefixed with `/api/`. Auth-protected unless noted:

| Method | Path                           | Purpose                                                       |
| ------ | ------------------------------ | ------------------------------------------------------------- |
| GET    | `/api/auth/login`              | Access-gated; upserts user, redirects (unprotected)           |
| GET    | `/api/auth/check`              | `{ authenticated, user }` (unprotected)                       |
| POST   | `/api/auth/logout`             | Clears cookie, returns Access logout URL (unprotected)        |
| POST   | `/api/upload`                  | Upload `.md` file (multipart form)                            |
| POST   | `/api/paste`                   | Save pasted markdown (JSON body)                              |
| GET    | `/api/files`                   | List all files                                                |
| GET    | `/api/files/:id`               | Get file content; anonymous OK for 'link' notes (unprotected) |
| PATCH  | `/api/files/:id`               | Rename file                                                   |
| PATCH  | `/api/files/:id/visibility`    | Set 'private' or 'link' (owner only)                          |
| DELETE | `/api/files/:id`               | Delete file                                                   |
| PUT    | `/api/files/:id`               | Edit content; creates a revision (owner only)                 |
| GET    | `/api/files/:id/revisions`     | Revision log, newest first (same read rules; unprotected)     |
| GET    | `/api/files/:id/revisions/:n`  | Raw markdown snapshot (same read rules; unprotected)          |
| GET    | `/api/history`                 | Get view history                                              |
| DELETE | `/api/history`                 | Clear all history                                             |
| DELETE | `/api/history/:id`             | Remove single history entry                                   |
| GET    | `/api/files/:id/comments`      | List review comments (owner only)                             |
| POST   | `/api/files/:id/comments`      | Add comment; 409 if anchor not in current source              |
| PATCH  | `/api/files/:id/comments/:cid` | Edit note/tag/status                                          |
| DELETE | `/api/files/:id/comments/:cid` | Delete comment                                                |
| POST   | `/api/dev/seed`                | UAT only: reset + seed scenarios                              |
| POST   | `/api/dev/retention`           | UAT only: run retention cron now                              |

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`): `ci` job (lint, format:check, typecheck, test) on PRs and pushes to `main`; `deploy` job runs `wrangler deploy` on push to `main` only after `ci` passes. Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets. Never deploy manually.

## Testing

`vitest.config.js` has two projects: `unit` (node, `src/**/*.test.js`) and `integration` (`@cloudflare/vitest-pool-workers`, `src/**/*.integration.test.js`, miniflare R2 `MD_FILES` + KV `HISTORY`, isolated storage off — every test calls `clearAll()` in `beforeEach`). Tests drive the Hono app directly via `worker.fetch(req, env, ctx)` with a stubbed `ASSETS` fetcher (`src/test-utils/app.js`), so they control the full env. Vitest is pinned to 3.x for pool-workers compat. `src/ownership.integration.test.js` covers per-user visibility/ownership rules and `src/migrate.integration.test.js` covers `migrateToOwner`; both use two-user scenarios via `asUser()`.

`src/revisions.integration.test.js` covers the edit/revision-log/snapshot flow.

`src/comments.integration.test.js` covers comment CRUD, ownership 404s, anchor validation, and cleanup on delete.

`public/js/comments-*.test.js` use a per-file `// @vitest-environment happy-dom`; everything else in the unit project stays in node.

Agent-driven UAT: `pnpm uat` → `.claude/skills/verifier-web/SKILL.md`.

## Routing

**Server-side:** A catch-all Hono route at the bottom of `src/worker.js` matches note paths and serves `index.html` via the `ASSETS` binding — this is the SPA fallback so direct file links and browser refresh work. Note URLs are base36-encoded UUIDs (25 chars, `[0-9a-z]`, e.g. `/djmlk8rqmyfbvw0cfe0lkllww`); legacy full-UUID paths are also accepted. Other paths return 404. Storage keys (R2/KV) remain plain UUIDs — the encoding is URL-layer only.

**Client-side:** `public/js/app.js` uses `history.pushState` / `popstate` for navigation. Viewing a file pushes `/<base36-id>` to the URL (`uuidToShortId`/`shortIdToUuid` in `app.js`); going back pushes `/`. A legacy `/<uuid>` deep link is decoded and rewritten to the short form via `replaceState`. Functions that change views accept `{ updateUrl: false }` to prevent double-pushing during `popstate` events. On initial load after auth, `showApp()` checks for a deep-linked file ID in the URL path.

## Key Patterns

- Client-side markdown rendering using CDN-loaded markdown-it and highlight.js (not bundled)
- The document is the only vertical scroller (no `overflow: auto` app shell). iOS Safari collapses its toolbars only for document scrolling; the sidebar is `position: sticky` on desktop (tucked under the topbar by a negative `margin-top` + matching `padding-top` so the page is never taller than the viewport), `fixed` on mobile; the note toolbar + History drawer (`.viewer-header`) are sticky so they stay reachable mid-note, and slide away on scroll down / return on scroll up (`public/js/header-autohide.js`; kept shown while editing, the drawer or a menu is open). Keep `background` off sticky/fixed elements at the top edge (use a `::before`): iOS 26 Safari tints its status bar from their `background-color`, even when translated away, which stops content scrolling under it. Below 768px, toolbar buttons marked `data-secondary` are hidden and offered from the ••• menu, whose items forward to the real buttons (`flashCopied` shows "Copied!" on ••• when the source button is hidden). Per-note scroll position is remembered as a ratio in `localStorage` (`scrollPos:{uuid}`, cap 50) by `public/js/scroll-memory.js` and restored in `viewFile`; `history.scrollRestoration` is `manual`
- Theme switching via `data-theme` attribute on `<html>` with CSS custom properties
- Sidebar uses CSS `margin-left` transition on desktop, `transform: translateX` on mobile (<768px)
- History is capped at 100 entries per user, stored as a single KV value at `history:{sub}`
- File metadata stored separately in KV (`meta:{uuid}`) from file content in R2
- SPA routing uses strict ID regexes (25-char base36 or legacy UUID) on both server and client — only valid file paths get the fallback
- Theme has three modes stored in `localStorage.theme`: `light`, `dark`, `device` (follows `prefers-color-scheme` live); `data-theme` on `<html>` always holds the resolved light/dark value
- Sidebar history is grouped under Today / Yesterday / This Week / Older headings based on `viewedAt`
- Wide tables are wrapped in `.table-wrapper` after render so they scroll horizontally within their own bounds
- Ownership: every write route checks `meta.ownerId === user.id` and answers 404 (never 403). `canRead()`: `link` → anyone, `private` → owner, legacy meta without `ownerId` → any authenticated user until `pnpm migrate:owner` has run.
- Listing a user's notes reads `user:{sub}:notes` then `getMetaMany`; never a `meta:` prefix scan (eventually consistent). Only the retention cron scans.
- Revisions: `PUT` snapshots rev 0 lazily on first edit; cap 100 with oldest snapshot deleted; `deleteNoteObjects()` is the only way a note's objects are removed. Diffs are client-side (`jsdiff` CDN). Note size cap 2 MB.
- Review comments anchor to the raw markdown (exact quote + 32-char context + 1-based line range), never to the DOM; `data-line` on rendered blocks maps selections back to source — on an indented code block it lands on the `<pre>`, not the fenced `<code>`, and a list's range may include its trailing blank line. Matching is whitespace-tolerant and treats each typographic character `markdown-it`'s `typographer` produces (`’ “ ” – — …`) as equal to its ASCII source form (`' " -- --- ...`) in both directions — equivalence, not fuzziness: an edit inside the quote still means the anchor is gone. A selection with no single covering block (paragraph into the next heading) is searched across the top-level blocks it touches, so only a quote `locate()` cannot find is labelled "anchor not found". Exported `L` numbers are always re-resolved against the current source. Highlights use the CSS Custom Highlight API so the rendered DOM is never mutated. The tag-picker shortcut is **Option/Alt+1–4** (matched on `e.code`, not the digit itself) so bare digit keys still type into the note. Review mode presents per layout (`review-layout.js`): margin rail ≥1024, a list drawer inside the sticky header at 768–1023, and below 768 a bottom review bar + bottom sheets. Input mode follows the pointer, not the width: `(pointer: coarse)` or the sheet layout shows a floating Comment pill on `selectionchange` (anchor captured then; `pointerdown` is prevented so the tap keeps the selection) — fine pointers keep the mouseup popover. Fixed review chrome paints its background via `::before` (iOS 26 rule) and the sheet rides above the keyboard with `--kb-inset` from `visualViewport`. Review mode is unavailable (button hidden, and on the ••• menu Copy feedback is absent too) while an old revision snapshot is shown. Design: `docs/plans/2026-09-18-markup-comments-design.md`.
