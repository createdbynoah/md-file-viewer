# CI / Tooling Gaps Proposal

Date: 2026-09-03
Compared against: `expense-planner`, `timesheet-dashboard`, `node-ynab-api-sync`

## Current state (md-file-viewer)

| Area              | Status                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| CI                | `deploy.yml` only. Deploys on push to `main`. No test/lint/typecheck gate anywhere.                            |
| Tests             | None. No framework.                                                                                            |
| Lint              | None.                                                                                                          |
| Format            | Prettier runs from a Claude hook via `npx` with **no config and no devDep** (floating version, default style). |
| Typecheck         | None (plain JS, no `jsconfig`).                                                                                |
| Git hooks         | None (no husky/lint-staged).                                                                                   |
| Branch protection | None on `main`.                                                                                                |
| UAT harness       | None. `settings.local.json` allows Playwright MCP tools but no script/skill exists.                            |
| Auth in tests     | N/A. Password + HMAC cookie today; new auth incoming.                                                          |
| Node pin          | Only in CI (`node-version: 22`). No `.nvmrc`.                                                                  |
| Templates         | PR + issue templates exist (parity).                                                                           |

## Precedent summary

| Capability                                                         | expense-planner  | timesheet          | ynab-sync             | Verdict for this repo                                    |
| ------------------------------------------------------------------ | ---------------- | ------------------ | --------------------- | -------------------------------------------------------- |
| `ci.yml` lint/typecheck/test on PR + push                          | yes              | test only          | yes                   | **Port**                                                 |
| Deploy `needs: ci`                                                 | yes              | no (gap)           | yes                   | **Port** (fix timesheet's mistake)                       |
| Vitest unit + `@cloudflare/vitest-pool-workers` integration        | yes (D1/KV)      | yes (D1)           | yes (D1/R2)           | **Port**, R2 + KV bindings                               |
| ESLint 9 flat + Prettier (printWidth 100, singleQuote, es5 commas) | yes              | referenced, broken | yes                   | **Port** (single-package, no shared config pkg)          |
| husky + lint-staged pre-commit                                     | yes              | no                 | yes                   | **Port**                                                 |
| `format:check` in CI                                               | no               | no                 | no                    | **New** (all three miss it)                              |
| `scripts/uat.mjs` + `uat-stop.mjs`                                 | yes              | yes                | no                    | **Port**, simplified (one process)                       |
| `.claude/skills/verifier-web`                                      | Playwright MCP   | Claude_Browser MCP | Playwright spec + MCP | **Port**, Claude_Browser variant                         |
| Stub-auth escape hatch + dev-routes 404 guardrail test             | yes              | yes                | OAuth stub            | **Port**, design now for incoming auth                   |
| Turbo                                                              | yes              | no                 | yes                   | Skip (single package)                                    |
| Coverage thresholds                                                | no               | no                 | web/db only           | Skip for now                                             |
| Dependabot / CODEOWNERS                                            | no               | no                 | no                    | Dependabot **new**, low priority; CODEOWNERS skip (solo) |
| Workflow `concurrency` + `permissions`                             | concurrency only | no                 | no                    | **New**                                                  |

## Proposal

### P0. Quality gate (port, ~half day)

1. **Add `.github/workflows/ci.yml`.** Triggers: `pull_request` → `main`, `push` → `main`. Steps: checkout, `pnpm/action-setup@v4`, `setup-node@v4` (node 22, pnpm cache), `pnpm install --frozen-lockfile`, then `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`. Add `concurrency: {group: ci-${{ github.ref }}, cancel-in-progress: true}`, `permissions: {contents: read}`, `timeout-minutes: 10`.
2. **Gate deploy on CI.** Move the deploy job into `ci.yml` as `deploy` with `needs: ci` and `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`. Delete `deploy.yml`. Drop the path filter (CI is cheap for this repo, and path filters on the trigger silently skip the gate).
3. **ESLint + Prettier as real devDeps.** `eslint@9` flat config (`@eslint/js` recommended, `globals` for browser in `public/**` and worker in `src/**`), `eslint-config-prettier`. `prettier.config.mjs` matching the other repos: `printWidth: 100, singleQuote: true, semi: true, trailingComma: 'es5'`. Scripts: `lint`, `format`, `format:check`. Expect a one-time reformat commit.
4. **husky + lint-staged.** `pre-commit` → `pnpm lint-staged`; `*.js` → `eslint --fix`, `prettier --write`; `*.{json,jsonc,md,css,html}` → `prettier --write`. Add `"prepare": "husky"`.
5. **Typecheck without migrating to TS.** `jsconfig.json` with `checkJs: true`, `strict: false` initially, `types: ["@cloudflare/workers-types"]`; script `typecheck: tsc --noEmit -p jsconfig.json`. Add `// @ts-check` per file as they're cleaned up. Cheapest way to catch undefined-binding and typo bugs in `worker.js`.
6. **Branch protection ruleset on `main`:** require `ci` status check, require PR, block force push. This is the only thing that makes the gate real.
7. **`.nvmrc` → `22`.** Update PR template Testing checklist to `pnpm lint`, `pnpm test`, `pnpm uat` (parity with the other three).

### P1. Tests (port, ~1 day)

8. **Vitest with two projects** (same shape as timesheet `backend/vitest.config.ts`):
   - `unit`: node pool, `src/**/*.test.js`, excludes `*.integration.test.js`. Targets: `logger.js` (level threshold, JSON shape), cookie sign/verify helpers, base36 id encode/decode, retention date math.
   - `integration`: `defineWorkersProject` with `wrangler.configPath`, miniflare `r2Buckets: ['MD_FILES']`, `kvNamespaces: ['HISTORY']`, `remoteBindings: false`. Targets, one file per route group: `auth` (login ok/bad, cookie tampering → 401, logout clears), `upload`/`paste`, `files` (list/get/rename/delete, delete removes R2 + meta), `history` (cap at 100, dedupe, clear, single remove), `folders`, `scheduled()` retention (archive at 30d, delete at 60d, access resets), SPA fallback (`/<base36>` → index.html, legacy uuid, junk → 404).
   - Pin `vitest@^3.2` (pool-workers compat, per timesheet's gotcha note).
9. **Make client helpers testable.** Extract pure functions from `app.js` (`uuidToShortId`, `shortIdToUuid`, history grouping Today/Yesterday/This Week/Older, table-wrapper logic) into `public/js/lib/*.js` ES modules loaded via `<script type="module">`. Test under jsdom. Optional; skip if app.js stays a classic script.
10. **Test helpers** at `src/test-utils/` (`test-app.js` building the Hono app with env overrides, `seed.js` shared with the UAT seed route).

### P2. Agentic UAT harness (port, ~half day)

11. **`scripts/uat.mjs` / `scripts/uat-stop.mjs`.** Simplified from expense-planner: single `wrangler dev --env uat --port <free from 8787>` (worker serves API and static assets, so no second process), pass `--var ENVIRONMENT:uat --var AUTH_STUB_USER:user_local_dev`, poll `/api/auth/check`, `POST /api/dev/seed`, write `.uat/state.json`, print `UAT ready: http://localhost:<port>`. Gitignore `.uat/`. Add `uat` / `uat:stop` scripts.
12. **`/api/dev/seed` + `/api/dev/reset`** in a new `src/routes/dev.js`, mounted only when `isDevEnv(env)` (`AUTH_STUB_USER` set AND `ENVIRONMENT` not `production`), else a `*` middleware returns 404. **Guardrail integration test** asserting 404 under production env (this is the test that must stay green; same as timesheet `dev.integration.test.ts`).
13. **Seed scenarios:** empty state; short note; long note with wide tables + fenced code in several languages; note with deep-link legacy uuid; 3 folders with nested files; files with `lastAccessedAt` 31d and 61d old (archive/delete paths); 100+ history entries (cap). Document in the skill.
14. **`.claude/skills/verifier-web/SKILL.md`.** Timesheet variant: `pnpm uat`, read port from ready line, drive with `mcp__Claude_Browser__*` (`navigate`, `read_page`, `screenshot`, `resize_window` for the 768px sidebar breakpoint, `read_console_messages{onlyErrors}`, `read_network_requests{urlPattern:'/api/'}`), light + dark via `resize_window colorScheme`, teardown with `pnpm uat:stop`. Either drop the Playwright MCP allowlist entries from `settings.local.json` or standardise on one tool; recommend Claude_Browser since it's already what timesheet uses and needs no extra server.
15. **`wrangler.jsonc` `env.uat`** with the same R2/KV bindings (local), `LOG_LEVEL: debug`, no custom domain/route/cron.

### P3. Auth-readiness (design now, land with auth)

16. **Stub-auth pattern, decided up front.** All three reference repos use Clerk with the same escape hatch: middleware short-circuits on `AUTH_STUB_USER` before the real verifier; UAT and integration tests set it, production never does. Adopt the same name now so `uat.mjs`, `dev.js`, and `test-app.js` don't change when auth lands. Today the stub sets a synthetic valid session for the password flow.
17. **Auth test matrix** to carry over: no credential → 401; tampered cookie/token → 401; stub user → 200; dev routes → 404 outside uat/dev; if multi-user arrives, per-user isolation on `/api/files` (expense-planner pattern: inject a different stub user, expect 404).
18. **Keep the `/api/auth/check` unauthenticated probe** so `uat.mjs` readiness polling survives the auth change.
19. **Secrets in CI:** when auth adds `CLERK_SECRET_KEY` (or similar), integration tests must run with `AUTH_STUB_USER` only; never put real auth secrets in CI. Deploy job keeps only Cloudflare secrets.

### P4. Hygiene (new, small)

20. **`.claude/settings.json`:** add a PostToolUse `eslint --fix` hook next to the Prettier one (both now resolve to pinned devDeps); keep the deploy/secret/remote deny-list, which is the best of the four repos' hook sets. Add `SessionStart` reminder line: "Tests: `pnpm test`; UAT: `pnpm uat`".
21. **`.github/dependabot.yml`** for npm + github-actions, weekly, grouped. None of the reference repos has it; low priority.
22. **Fix `deploy.yml` path filter** if kept: it omits `pnpm-lock.yaml`, so a dependency bump alone never deploys. Moot if item 2 removes the filter.
23. **Delete stray empty `1export` file** at repo root (also present in expense-planner).
24. **`docs/DEPLOYMENT.md`** CI section: describe the gate, the `needs: ci` deploy, and `pnpm uat`.

## Suggested order

1. P0 items 3, 4, 5, 7 in one PR (tooling + reformat). 2. P0 items 1, 2, 6 (CI + protection). 3. P1 (tests). 4. P2 (UAT). 5. P3 alongside the auth PR. 6. P4 whenever.

## Explicitly not proposed

- Turbo (single package). - Coverage thresholds (add after P1 stabilises; ynab uses 75/75/55/45). - Playwright spec-file harness (ynab style): overkill for a two-file SPA; MCP-driven verifier covers it. - TypeScript migration. - CODEOWNERS.
