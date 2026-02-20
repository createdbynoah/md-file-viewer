# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

md-file-viewer is a password-protected Markdown file viewer running on Cloudflare Workers. Users can upload `.md` files or paste markdown text, which gets stored in R2 and rendered client-side with markdown-it + highlight.js.

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Local dev server on port 8787 (emulates R2/KV locally)
pnpm run deploy       # Deploy to Cloudflare Workers
```

No test framework is configured. No linter is configured.

## Architecture

**Backend:** Single Hono app in `src/worker.js` — all API routes in one file. Runs as a Cloudflare Worker.

**Frontend:** Vanilla JS SPA in `public/` — no build step, no bundler. Static assets served via Workers Static Assets from the `public/` directory.
- `public/index.html` — full HTML structure (login screen + app screen, toggled via `hidden` attribute)
- `public/js/app.js` — all client logic (auth, file upload, paste, history, markdown rendering)
- `public/css/style.css` — CSS custom properties for light/dark theming

**Storage bindings** (configured in `wrangler.jsonc`):
- `MD_FILES` — R2 bucket, stores raw markdown as `{uuid}.md`
- `HISTORY` — KV namespace, stores `history` (JSON array, max 100 entries) and `meta:{uuid}` (per-file metadata)

**Auth:** HMAC-SHA256 signed cookies via Web Crypto API. Middleware on `/api/*` checks the cookie, exempting `/api/auth/login` and `/api/auth/check`. Secrets `ACCESS_PASSWORD` and `COOKIE_SECRET` come from Wrangler secrets (production) or `.dev.vars` (local dev).

## API Routes

All routes are prefixed with `/api/`. Auth-protected unless noted:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/login` | Login (unprotected) |
| GET | `/api/auth/check` | Check auth status (unprotected) |
| POST | `/api/auth/logout` | Logout |
| POST | `/api/upload` | Upload `.md` file (multipart form) |
| POST | `/api/paste` | Save pasted markdown (JSON body) |
| GET | `/api/files` | List all files |
| GET | `/api/files/:id` | Get file content |
| DELETE | `/api/files/:id` | Delete file |
| GET | `/api/history` | Get view history |
| DELETE | `/api/history` | Clear all history |
| DELETE | `/api/history/:id` | Remove single history entry |

## CI/CD

GitHub Actions (`.github/workflows/deploy.yml`) auto-deploys to Cloudflare Workers on push to `main` when `src/`, `public/`, `wrangler.jsonc`, or `package.json` change. Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets.

## Key Patterns

- Client-side markdown rendering using CDN-loaded markdown-it and highlight.js (not bundled)
- Theme switching via `data-theme` attribute on `<html>` with CSS custom properties
- Sidebar uses CSS `margin-left` transition on desktop, `transform: translateX` on mobile (<768px)
- History is capped at 100 entries, stored as a single KV value
- File metadata stored separately in KV (`meta:{uuid}`) from file content in R2
