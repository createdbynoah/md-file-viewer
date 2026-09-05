# Auth, Ownership, Sharing, and Edit History — Design

Date: 2026-09-04
Supersedes: issue #28 epic (`arctic` GitHub + Google OAuth, Feb 2026)

## Decision

Use **Cloudflare Access (Zero Trust, free plan)** as the identity provider. The Worker
verifies the Access JWT and owns everything above identity: users, note ownership,
visibility, edit rights, revisions, history.

Rejected:

- `arctic` hand-rolled OAuth (Feb plan): ~400 LOC of state/PKCE/session code plus four
  secrets and two OAuth app registrations, all duplicating what Access does in the dashboard.
- Better Auth on D1: adds a database and ORM surface to a one-file worker.
- Clerk: external vendor, JS SDK in a no-bundler SPA, paid past free tier.

Constraint accepted: Access free plan is capped at **50 seats**. This app is for the owner
plus invited people, not open signup. If open signup is ever needed, revisit `arctic`.

Approved choices: default visibility **private**; edit rights **owner-only** (editors list
is reserved in the schema but not exposed).

## Identity

### Cloudflare dashboard (one-time chore)

- Zero Trust > Access > Applications: self-hosted app, domain
  `notebook.noahcancode.com`, path `/api/auth/login`. Only this path is gated. Everything
  else on the domain is served directly by the Worker so public links stay public.
- Policy: Allow. Login methods: Google, GitHub (add One-time PIN if wanted). Session 1 month.
- Record the app **AUD tag** and the team domain (`<team>.cloudflareaccess.com`).
- Worker vars (`wrangler.jsonc` `vars`, not secrets): `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`.
  Secrets `ACCESS_PASSWORD` and `COOKIE_SECRET` are deleted.

### Flow

1. Login button links to `/api/auth/login`. Access intercepts, shows provider chooser,
   authenticates, sets `CF_Authorization` cookie (path `/`, HttpOnly) on the domain, and
   forwards the request to the Worker.
2. Worker `GET /api/auth/login` handler: verify JWT, upsert user, redirect to `/` (or to
   `?next=` if it is a same-origin note path).
3. Every `/api/*` request: middleware reads `CF_Authorization` cookie, verifies, and sets
   `c.set('user', { id, email })` or `null`. Verification failure is treated as anonymous,
   never as an error.
4. Logout: `POST /api/auth/logout` clears the cookie and returns
   `{ redirect: 'https://notebook.noahcancode.com/cdn-cgi/access/logout' }`; client navigates
   there.

### JWT verification (`src/auth.js`, new file)

- JWKS from `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, cached in module scope
  with a 1 h TTL and refetched once on `kid` miss.
- Verify RS256 via Web Crypto (`crypto.subtle.importKey('jwk')` + `verify`). No dependency.
- Claims checked: `aud` contains `ACCESS_AUD`, `iss === https://${ACCESS_TEAM_DOMAIN}`,
  `exp` in the future, `type === 'app'`.
- Returns `{ id: sub, email }`. `sub` is stable per email per Zero Trust org.

### Dev / UAT

`isDevEnv(env)` stub stays in front of the verifier (per CLAUDE.md). Under the stub:

- `AUTH_STUB_USER` is the default identity.
- Request header `X-Dev-User: <id>` overrides it so integration tests and UAT can act as
  two users. Ignored outside dev env.
- `pnpm dev` without the stub: unauthenticated, read-only on `link` notes. Local login is
  not possible without Access; that is acceptable.

## Data model (KV `HISTORY` + R2 `MD_FILES`, no D1)

| Key                | Value                                                               |
| ------------------ | ------------------------------------------------------------------- |
| `user:{sub}`       | `{ id, email, createdAt, lastSeenAt }`                              |
| `user:{sub}:notes` | JSON array of note uuids, newest first (authoritative owner index)  |
| `history:{sub}`    | existing history array, per user                                    |
| `folders:{sub}`    | existing folders array, per user                                    |
| `meta:{uuid}`      | existing fields + `ownerId`, `visibility`, `editors`, `currentRev`  |
| `rev:{uuid}`       | JSON array `[{ n, at, by, message, bytes }]`, newest first, cap 100 |

R2:

| Key               | Content                         |
| ----------------- | ------------------------------- |
| `{uuid}.md`       | current content (unchanged key) |
| `{uuid}/r/{n}.md` | snapshot after revision `n`     |

`visibility`: `'private'` (owner only) or `'link'` (anyone with the URL can read).
`editors`: array of subs, always `[]` for now. Write checks use `ownerId` only.

Per-user note index replaces prefix listing: `kv.list` is eventually consistent and the
code already works around it (`getMetaMany`). `GET /api/files` reads `user:{sub}:notes`
then `getMetaMany`.

### Migration (`scripts/migrate-owner.mjs`, run once via `wrangler kv` API or a

dev-only route under `isDevEnv`)

- Every existing `meta:*` gets `ownerId = <Noah's sub>`, `visibility = 'link'`
  (today's effective behavior), `editors = []`, `currentRev = 0`.
- Existing `history` → `history:{sub}`, `folders` → `folders:{sub}`, all uuids →
  `user:{sub}:notes`.
- Legacy keys deleted after verification.

## Authorization rules

| Route                                  | Anonymous   | Authed non-owner    | Owner |
| -------------------------------------- | ----------- | ------------------- | ----- |
| `GET /api/files/:id`                   | `link` only | `link` only         | yes   |
| `GET /api/files/:id/revisions[/:n]`    | `link` only | `link` only         | yes   |
| `GET /api/files`, history, folders     | 401         | own data            | own   |
| `POST upload/paste`                    | 401         | yes (becomes owner) | yes   |
| `PUT /api/files/:id` (edit)            | 404         | 404                 | yes   |
| `PATCH` rename, `DELETE`, folder moves | 404         | 404                 | yes   |
| `PATCH /api/files/:id/visibility`      | 404         | 404                 | yes   |

Non-owner write attempts and private reads return **404**, never 403, to avoid leaking
existence. `GET /api/files/:id` response gains `owned: boolean` and `visibility`; history
is only appended for the viewer's own `history:{sub}` when authenticated.

`GET /api/auth/check` returns `{ authenticated, user: { id, email } | null }`.

Retention cron: iterate `meta:*` as today; folder exemption looks up `folders:{ownerId}`
(cached per owner within the run). Revision snapshots are deleted with the note.

## Edit, change log, diffs

- `PUT /api/files/:id` body `{ content, message? }`. Rejects if `content` unchanged from
  current (no empty revisions). Steps: `n = currentRev + 1`; put `{uuid}/r/{n}.md`; put
  `{uuid}.md`; prepend to `rev:{uuid}`; set `meta.currentRev = n`, `lastAccessedAt`.
  If `rev:{uuid}` exceeds 100 entries, drop the oldest entry and delete its R2 object.
- Revision 0 is implicit: the content as first uploaded/pasted. On the first edit, the
  pre-edit content is snapshotted as `{uuid}/r/0.md` so diffs against the original work.
- `GET /api/files/:id/revisions` → `[{ n, at, by: email, message, bytes }]`.
- `GET /api/files/:id/revisions/:n` → raw markdown.
- Diffing is client-side with `jsdiff` from a CDN, matching the markdown-it/highlight.js
  pattern. No server-side diff.
- Size limit on `PUT` matches current upload limit.

## Frontend

- Login screen: single "Sign in" button → `/api/auth/login`. Provider chooser is Access's.
- Sidebar footer: email + Sign out.
- Note header (owner only): Edit, Visibility toggle (Private / Anyone with link) with copy
  link, History (revisions).
- Edit mode: textarea replacing the rendered view, optional commit message, Save / Cancel,
  Cmd/Ctrl+S saves. Preview toggle re-renders with markdown-it. No CodeMirror.
- Revisions drawer: list; select one → view that snapshot read-only; select two → unified
  diff rendered with `jsdiff`, added/removed lines coloured via existing theme tokens.
- Anonymous deep link to a `link` note: read-only view, no sidebar, "Sign in" in header.
  Private or missing → 404 view with Sign in.
- Deep link while logged in but not owner: same read-only view, sidebar shows own notes.

## Testing

- Unit (`src/auth.test.js`): JWT verify with a generated RSA key pair and a fake JWKS
  fetch; expired, wrong aud, wrong iss, bad signature, wrong kid.
- Integration (`src/*.integration.test.js`) using `X-Dev-User` to act as `alice`/`bob`:
  ownership isolation on list/rename/delete/folders; visibility private vs link for
  anon/bob/alice; edit creates revisions, cap eviction deletes R2 objects; revision 0
  snapshot; retention with per-owner folders; migration script on seeded legacy keys.
- `src/dev.integration.test.js` guardrail extended: `X-Dev-User` ignored when not dev env.
- UAT seed (`/api/dev/seed`) gains a second owner and a private + link note pair.

## Delivery order

1. Access app + vars chore; `src/auth.js` + middleware + login/logout/check; stub header.
   Old password login removed. App still single-owner in effect.
2. Data model + migration + per-user routes + visibility + authorization rules + frontend
   sign-in/ownership/visibility UI + anonymous read-only deep links.
3. Edit + revisions + diff (backend, then frontend).

Each step ships as its own PR behind the CI gate. Step 2 deploys with the migration script
run immediately after (one-time, manual, documented in `docs/DEPLOYMENT.md`). Between
step 1 and step 2, sign in with the owner account once so the `sub` for the migration is
known.
