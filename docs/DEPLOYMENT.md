# Deployment

md-file-viewer runs on Cloudflare Workers with R2 (file storage) and KV (history/metadata).

## Architecture

| Component | Service | Details |
|-----------|---------|---------|
| Server | Cloudflare Worker | Hono framework, `src/worker.js` |
| Static assets | Workers Static Assets | `public/` directory, served from edge CDN |
| File storage | R2 bucket | `md-file-viewer-files`, keyed as `{uuid}.md` |
| History + metadata | KV namespace | `history` key (JSON array) + `meta:{uuid}` keys |
| Auth | Web Crypto API | HMAC-SHA256 signed cookies |
| Secrets | Wrangler secrets | `ACCESS_PASSWORD`, `COOKIE_SECRET` |

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/)
- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers enabled
- [GitHub CLI](https://cli.github.com/) (`gh`) for PR workflows

## First-time setup

### 1. Create Cloudflare resources

```bash
# R2 bucket for markdown files
npx wrangler r2 bucket create md-file-viewer-files

# KV namespace for history and metadata
npx wrangler kv namespace create HISTORY
```

The KV command outputs a namespace ID. Update `wrangler.jsonc` with it:

```jsonc
"kv_namespaces": [
  {
    "binding": "HISTORY",
    "id": "<your-namespace-id>"
  }
]
```

### 2. Set secrets

```bash
npx wrangler secret put ACCESS_PASSWORD
npx wrangler secret put COOKIE_SECRET
```

`ACCESS_PASSWORD` is the login password for the app. `COOKIE_SECRET` is used to sign auth cookies — generate one with:

```bash
openssl rand -base64 32
```

### 3. Set up GitHub Actions

Add these as [repository secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions) in your GitHub repo settings:

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | API token with Workers/R2/KV permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID (found in dashboard URL or sidebar) |

To create an API token: Cloudflare dashboard > My Profile > API Tokens > Create Token > Use the "Edit Cloudflare Workers" template.

### 4. Deploy

```bash
pnpm run deploy
```

The app will be live at `md-file-viewer.<your-account>.workers.dev`.

## CI/CD

Deployments are automated via GitHub Actions (`.github/workflows/deploy.yml`).

**Trigger:** Push to `main` that changes any of these paths:
- `src/**`
- `public/**`
- `wrangler.jsonc`
- `package.json`
- `.github/workflows/deploy.yml`

**What it does:**
1. Checks out the code
2. Installs dependencies with pnpm
3. Runs `wrangler deploy` with Cloudflare credentials from repo secrets

PRs do not trigger deployments — only merges to `main`.

## Local development

```bash
# Install dependencies
pnpm install

# Start local dev server (port 8787)
pnpm dev
```

Wrangler emulates R2 and KV locally — no Cloudflare account needed for development. Local data is stored in `.wrangler/` (gitignored).

Local secrets are read from `.dev.vars` (gitignored):

```
ACCESS_PASSWORD=changeme
COOKIE_SECRET=dev-secret-change-in-production
```

## Manual deployment

```bash
pnpm run deploy
```

This runs `wrangler deploy`, which requires either:
- Being logged in via `npx wrangler login`, or
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment variables

## Storage details

### R2 (files)

- Bucket: `md-file-viewer-files`
- Key pattern: `{uuid}.md`
- Contains raw markdown text
- No expiration — files persist until deleted

### KV (history + metadata)

- Key `history`: JSON array of `{ id, filename, source, viewedAt }` (max 100 entries)
- Key `meta:{uuid}`: JSON object `{ filename, source, size, created }` for each file
- KV is eventually consistent (reads may lag writes by a few seconds globally)

## Troubleshooting

### Deployment fails with auth error
Verify your `CLOUDFLARE_API_TOKEN` has the correct permissions and hasn't expired.

### KV namespace not found
Make sure the `id` in `wrangler.jsonc` matches the namespace ID from `npx wrangler kv namespace list`.

### Changes deployed but not visible
Workers and KV use edge caching. Changes propagate globally within ~60 seconds. Hard refresh (`Ctrl+Shift+R`) to bypass browser cache for static assets.

### Local dev data disappeared
Wrangler stores local R2/KV data in `.wrangler/state/`. This persists between `pnpm dev` runs but is gitignored.
