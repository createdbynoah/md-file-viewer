---
name: verifier-web
description: Use when verifying frontend behavior of md-file-viewer in a real browser (checking a PR, confirming a UI fix, responsive/theme checks). Brings the app up with `pnpm uat` (auth auto-bypassed, deterministic seed), lists the seed scenarios, and gives the browser-driving + evidence-capture patterns for this app.
---

# Verifying the web app (headless UAT)

Use this to confirm UI behavior in a real browser rather than in tests. It composes
the auth stub, the dev seed, and `pnpm uat`.

The app is password-protected (and will move to a real auth provider). `pnpm uat`
sidesteps login entirely: the Worker runs with `AUTH_STUB_USER=user_local_dev` under
the `uat` wrangler environment, so `/api/auth/check` reports authenticated and the SPA
opens straight into the app.

## 1. Bring the app up

```bash
pnpm uat
```

Picks a free port from 8787 upward, starts `wrangler dev --env uat` detached, seeds,
and prints:

```
UAT ready: http://localhost:<port>
```

**Read the port off that line — it is auto-selected**, so a `pnpm dev` already on 8787
is not a conflict. Log: `.uat/worker.log`. State (pid + port): `.uat/state.json`.

The Worker serves both `/api/*` and the static SPA, so there is one process and one URL.

## 2. What the seed gives you

Fixed UUIDs (`src/seed.js` → `SEED_IDS`) so deep links are stable across re-seeds.

| Note / folder                      | Use it to verify                                                          |
| ---------------------------------- | ------------------------------------------------------------------------- |
| **Short note.md** (upload)         | Basic render, upload badge, rename/delete                                 |
| **Wide table**                     | `.table-wrapper` horizontal scroll, page must not scroll sideways         |
| **Code blocks**                    | highlight.js themes (js/python/bash/no-lang), light + dark swap           |
| **Long note**                      | Scroll container, sticky topbar, 60 sections                              |
| **Project Alpha** folder (2 files) | Folder grouping, move/remove file, folder rename                          |
| **Recipes** folder (1 file)        | Second folder for move targets                                            |
| **Empty folder**                   | Empty-folder state                                                        |
| **Archived note**                  | 31d idle + `archivedAt`: hidden from sidebar/history, still deep-linkable |
| **Expiring note**                  | 59d idle: survives one retention run, deleted on the next                 |

History is seeded across Today / Yesterday / This Week / Older buckets.

Re-seed (replaces, never duplicates) or force the retention cron:

```bash
curl -X POST http://localhost:<port>/api/dev/seed
curl -X POST http://localhost:<port>/api/dev/retention
```

## 3. Drive it

Use the in-app browser tools (`mcp__Claude_Browser__*`):

1. `navigate` to `http://localhost:<port>/` (sidebar + empty viewer) or straight to a
   note's short URL from the sidebar.
2. `read_page` for the accessibility tree; `computer{action:"screenshot"}` to look.
3. `javascript_tool` for layout facts — `document.documentElement.scrollWidth <= innerWidth`
   (no horizontal page scroll), `.table-wrapper` `scrollWidth > clientWidth`, computed
   colors under `data-theme`.
4. `resize_window` — `mobile` for the `<768px` sidebar `translateX` behavior, `desktop`
   to reset. `colorScheme: 'dark'` to check the `device` theme mode follows the OS.

## 4. Capture evidence

- `computer{action:"screenshot"}` before/after.
- `read_console_messages{onlyErrors:true}` — there should be **no** errors. CDN
  `highlight.js` / `markdown-it` load from cdnjs/jsdelivr; if offline they will fail
  and rendering is not testable.
- `read_network_requests{urlPattern:"/api/"}` — confirm the page fetched and got 200s.
  "Renders but fetches nothing" is the failure mode screenshots hide.

## 5. Tear down

```bash
pnpm uat:stop
```

Always stop when done — `pnpm uat` refuses to start while a previous session is alive.

## How the bypass stays out of production

`isDevEnv()` in `src/worker.js` requires **both** `AUTH_STUB_USER` (passed only by
`scripts/uat.mjs` via `wrangler dev --var`, present in no deployment) **and**
`ENVIRONMENT !== 'production'` (production pins `ENVIRONMENT: "production"` in
`wrangler.jsonc` `vars`). Outside that, `/api/dev/*` returns 404 before auth runs and
the stub is ignored. `src/dev.integration.test.js` covers every combination — if you
touch either gate, keep those tests green.

When real auth lands, keep the `AUTH_STUB_USER` short-circuit in front of the new
verifier so this harness and the integration tests keep working unchanged.
