# Deployment

md-file-viewer runs on Cloudflare Workers with R2 (file storage) and KV (history/metadata).

## Architecture

| Component          | Service               | Details                                                      |
| ------------------ | --------------------- | ------------------------------------------------------------ |
| Server             | Cloudflare Worker     | Hono framework, `src/worker.js`                              |
| Static assets      | Workers Static Assets | `public/` directory, served from edge CDN                    |
| File storage       | R2 bucket             | `md-file-viewer-files`, keyed as `{uuid}.md`                 |
| History + metadata | KV namespace          | `history` key (JSON array) + `meta:{uuid}` keys              |
| Auth               | Cloudflare Access     | Zero Trust app on `/api/auth/login`; Worker verifies the JWT |
| Config vars        | `wrangler.jsonc` vars | `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`                           |

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

### 2. Create the Cloudflare Access application

Zero Trust (free plan, up to 50 users) issues the login session; the Worker only verifies it.

1. Cloudflare dashboard → Zero Trust → Access → Applications → **Add an application** → Self-hosted.
2. Application domain: `notebook.noahcancode.com`, path: `api/auth/login`. **Only this path is gated**; every other path (including shared note links) is served by the Worker directly.
3. Identity providers: enable Google and GitHub under Zero Trust → Settings → Authentication (One-time PIN optional). Select them on the application.
4. Policy: name `allow-users`, action **Allow**, include rule **Everyone** (or restrict by email). Session duration: 1 month.
5. Cookie settings (application → Settings → Cookies): **SameSite Attribute** `Lax` and **HTTP Only** on. `CF_Authorization` replaces the old `SameSite=Lax` `auth` cookie, and Lax is what keeps cross-site POSTs from riding the session.
6. Save, then open the application → Overview and copy the **Application Audience (AUD) Tag**.
7. Put the AUD and your team domain (`<team>.cloudflareaccess.com`, from Zero Trust → Settings → Custom Pages) into `wrangler.jsonc` `vars`:

   "ACCESS_AUD": "<aud tag>",
   "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",

   These are not secrets; commit them.

8. Delete the legacy secrets once the new build is deployed:

   ```bash
   npx wrangler secret delete ACCESS_PASSWORD
   npx wrangler secret delete COOKIE_SECRET
   ```

Until step 7 is deployed, the app returns 401 for everything except `/api/auth/*`.

Note: logout clears the app's `CF_Authorization` cookie but not the team-domain SSO session, so a
following "Sign in" often skips the identity-provider chooser and signs the same user straight back in.

### 3. Set up GitHub Actions

Add these as [repository secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions) in your GitHub repo settings:

| Secret                  | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | API token with Workers/R2/KV permissions                       |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID (found in dashboard URL or sidebar) |

To create an API token: Cloudflare dashboard > My Profile > API Tokens > Create Token > Use the "Edit Cloudflare Workers" template.

### 4. Deploy

```bash
pnpm run deploy
```

The app will be live at `md-file-viewer.<your-account>.workers.dev`.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on every PR into `main` and every push to `main`.

**`ci` job:** `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`.

**`deploy` job:** runs only on push to `main`, only after `ci` succeeds (`needs: ci`). Runs `wrangler deploy` with Cloudflare credentials from repo secrets. There is no path filter — every green merge to `main` deploys.

PRs never deploy. `main` has a ruleset requiring the `ci` check and a PR before merge.

## UAT harness

`pnpm uat` starts `wrangler dev --env uat` detached with `AUTH_STUB_USER` (auth bypassed, `/api/dev/seed` available), seeds deterministic scenarios, and prints the URL. `pnpm uat:stop` tears it down. The `uat` env in `wrangler.jsonc` has no route or cron. See `.claude/skills/verifier-web/SKILL.md`.

## Local development

```bash
# Install dependencies
pnpm install

# Start local dev server (port 8787)
pnpm dev
```

Wrangler emulates R2 and KV locally — no Cloudflare account needed for development. Local data is stored in `.wrangler/` (gitignored).

Cloudflare Access cannot run locally, so plain `pnpm dev` is anonymous (read-only once
step 2 of the auth design lands). Use `pnpm uat` for an authenticated stub session; send
`X-Dev-User: <id>` to act as a different user. `.dev.vars` (gitignored) only needs:

    LOG_LEVEL=debug

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
