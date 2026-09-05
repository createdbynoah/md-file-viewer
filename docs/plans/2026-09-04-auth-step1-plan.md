# Auth Step 1 — Cloudflare Access Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared-password HMAC-cookie login with Cloudflare Access: the Worker verifies the Access JWT, knows who the user is, and exposes login/logout/check. Nothing about ownership changes yet.

**Architecture:** A new `src/auth.js` verifies Access application tokens (RS256, JWKS from the team domain) with Web Crypto only. The `/api/*` middleware in `src/worker.js` sets `c.get('user')` to `{ id, email }` or `null`, and still 401s protected routes when `user` is null. The existing `isDevEnv` stub stays in front of the verifier and gains an `X-Dev-User` header override. Frontend login becomes a single link to `/api/auth/login`.

**Tech Stack:** Cloudflare Workers, Hono 4, Web Crypto (`crypto.subtle`), vitest 3 (`unit` node project + `integration` workers-pool project), vanilla JS SPA.

**Spec:** `docs/plans/2026-09-04-auth-design.md` — sections "Identity", "Dev / UAT", "Testing", "Delivery order" step 1. Issues #68, #69.

## Global Constraints

- No new runtime dependencies. JWT verification uses `crypto.subtle` only (spec: "No dependency").
- `isDevEnv(env)` semantics unchanged: `Boolean(env.AUTH_STUB_USER) && env.ENVIRONMENT !== 'production'`. Stub short-circuits in front of the verifier (CLAUDE.md).
- `src/dev.integration.test.js` must stay green at every commit.
- Non-dev, unauthenticated requests to protected `/api/*` routes still return 401 (ownership/visibility is step 2).
- `X-Dev-User` header is honoured only when `isDevEnv(env)` is true.
- Vars, not secrets: `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc` (top-level `vars` and `env.uat.vars`).
- `ACCESS_PASSWORD` / `COOKIE_SECRET` removed from code, tests, UAT script, docs.
- Every commit passes `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`. The pre-commit hook runs eslint + prettier on staged files.
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File map

| File                                    | Responsibility                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `src/auth.js` (new)                     | `verifyAccessJwt`, JWKS cache, `resetJwksCache`. Pure; no Hono.                |
| `src/auth.test.js` (new)                | Unit tests for `auth.js` with a generated RSA key and a fake JWKS fetch.       |
| `src/worker.js`                         | Env typedef, `user` context variable, middleware, `/api/auth/*` routes.        |
| `src/test-utils/app.js`                 | `authed`/`paste` switch to the dev stub; `login` removed; `asUser` added.      |
| `src/auth.integration.test.js`          | Rewritten: real JWT path through the middleware with a stubbed global `fetch`. |
| `src/dev.integration.test.js`           | Adds `X-Dev-User` guardrails.                                                  |
| `vitest.config.js`                      | Bindings: `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`; drop password/cookie secret.     |
| `wrangler.jsonc`, `scripts/uat.mjs`     | Vars for prod + uat; UAT script stops passing password vars.                   |
| `public/index.html`, `public/js/app.js` | Sign-in link, logout redirect, `check` shape.                                  |
| `docs/DEPLOYMENT.md`, `CLAUDE.md`       | Access setup steps, vars, dev notes.                                           |

---

### Task 1: `src/auth.js` — verify an Access JWT

**Files:**

- Create: `src/auth.js`
- Test: `src/auth.test.js`

**Interfaces:**

- Produces:
  - `verifyAccessJwt(token: string | undefined, opts: { aud: string, teamDomain: string }): Promise<{ id: string, email: string } | null>`
  - `resetJwksCache(): void` (tests only)
  - Uses global `fetch` at call time (so tests can stub it).

- [ ] **Step 1: Write the failing tests**

`src/auth.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { verifyAccessJwt, resetJwksCache } from './auth.js';

const TEAM = 'test.cloudflareaccess.com';
const AUD = 'aud-123';
const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;

function b64url(bytes) {
  const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function makeKey(kid = 'kid-1') {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

async function mint(key, claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: 'RS256', typ: 'JWT', kid: key.kid, ...header };
  const p = {
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: now + 3600,
    iat: now,
    type: 'app',
    sub: 'user-sub-1',
    email: 'alice@example.com',
    ...claims,
  };
  const data = `${b64url(JSON.stringify(h))}.${b64url(JSON.stringify(p))}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(data)
  );
  return `${data}.${b64url(sig)}`;
}

function stubCerts(...keys) {
  const fetchMock = vi.fn(async (url) => {
    expect(String(url)).toBe(CERTS_URL);
    return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const opts = { aud: AUD, teamDomain: TEAM };

describe('verifyAccessJwt', () => {
  beforeEach(() => {
    resetJwksCache();
    vi.unstubAllGlobals();
  });

  it('returns id + email for a valid token', async () => {
    const key = await makeKey();
    stubCerts(key);
    expect(await verifyAccessJwt(await mint(key), opts)).toEqual({
      id: 'user-sub-1',
      email: 'alice@example.com',
    });
  });

  it('accepts a string aud claim', async () => {
    const key = await makeKey();
    stubCerts(key);
    expect(await verifyAccessJwt(await mint(key, { aud: AUD }), opts)).not.toBeNull();
  });

  it('returns null for missing or malformed tokens', async () => {
    stubCerts(await makeKey());
    expect(await verifyAccessJwt(undefined, opts)).toBeNull();
    expect(await verifyAccessJwt('', opts)).toBeNull();
    expect(await verifyAccessJwt('a.b', opts)).toBeNull();
    expect(await verifyAccessJwt('not.a.jwt', opts)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const key = await makeKey();
    stubCerts(key);
    const t = await mint(key, { exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await verifyAccessJwt(t, opts)).toBeNull();
  });

  it('rejects wrong aud', async () => {
    const key = await makeKey();
    stubCerts(key);
    expect(await verifyAccessJwt(await mint(key, { aud: ['other'] }), opts)).toBeNull();
  });

  it('rejects wrong iss', async () => {
    const key = await makeKey();
    stubCerts(key);
    const t = await mint(key, { iss: 'https://evil.cloudflareaccess.com' });
    expect(await verifyAccessJwt(t, opts)).toBeNull();
  });

  it('rejects non-app token types', async () => {
    const key = await makeKey();
    stubCerts(key);
    expect(await verifyAccessJwt(await mint(key, { type: 'org' }), opts)).toBeNull();
  });

  it('rejects alg other than RS256', async () => {
    const key = await makeKey();
    stubCerts(key);
    expect(await verifyAccessJwt(await mint(key, {}, { alg: 'none' }), opts)).toBeNull();
    expect(await verifyAccessJwt(await mint(key, {}, { alg: 'HS256' }), opts)).toBeNull();
  });

  it('rejects a bad signature', async () => {
    const key = await makeKey();
    const other = await makeKey('kid-1'); // same kid, different key
    stubCerts(key);
    expect(await verifyAccessJwt(await mint(other), opts)).toBeNull();
  });

  it('rejects a token whose payload was altered', async () => {
    const key = await makeKey();
    stubCerts(key);
    const t = await mint(key);
    const [h, , s] = t.split('.');
    const forged = `${h}.${b64url(JSON.stringify({ sub: 'x', email: 'x' }))}.${s}`;
    expect(await verifyAccessJwt(forged, opts)).toBeNull();
  });

  it('caches JWKS across calls and refetches once on unknown kid', async () => {
    const k1 = await makeKey('kid-1');
    const k2 = await makeKey('kid-2');
    const fetchMock = stubCerts(k1);
    await verifyAccessJwt(await mint(k1), opts);
    await verifyAccessJwt(await mint(k1), opts);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // rotate keys server-side
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ keys: [k1.jwk, k2.jwk] }))
    );
    expect(await verifyAccessJwt(await mint(k2), opts)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // an unknown kid does not trigger unbounded refetching
    const k3 = await makeKey('kid-3');
    expect(await verifyAccessJwt(await mint(k3), opts)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns null when the JWKS endpoint fails', async () => {
    const key = await makeKey();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    );
    expect(await verifyAccessJwt(await mint(key), opts)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project unit src/auth.test.js`
Expected: FAIL — `Failed to resolve import "./auth.js"`.

- [ ] **Step 3: Implement `src/auth.js`**

```js
// Cloudflare Access application-token verification.
// Access sets a `CF_Authorization` cookie (and a `Cf-Access-Jwt-Assertion`
// header on the gated path). We verify it against the team's JWKS with
// Web Crypto only. See docs/plans/2026-09-04-auth-design.md.

const JWKS_TTL_MS = 60 * 60 * 1000;

/** @type {{ teamDomain: string, keys: Map<string, JsonWebKey>, fetchedAt: number } | null} */
let jwksCache = null;

export function resetJwksCache() {
  jwksCache = null;
}

function b64urlDecodeToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlDecodeJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(s)));
}

async function fetchJwks(teamDomain) {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const k of body.keys || []) if (k.kid) keys.set(k.kid, k);
  jwksCache = { teamDomain, keys, fetchedAt: Date.now() };
  return keys;
}

async function getKey(teamDomain, kid, { allowRefetch }) {
  const fresh =
    jwksCache &&
    jwksCache.teamDomain === teamDomain &&
    Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  let keys = fresh ? jwksCache.keys : await fetchJwks(teamDomain);
  if (!keys.has(kid) && fresh && allowRefetch) keys = await fetchJwks(teamDomain);
  return keys.get(kid) || null;
}

/**
 * @param {string | undefined} token
 * @param {{ aud: string, teamDomain: string }} opts
 * @returns {Promise<{ id: string, email: string } | null>}
 */
export async function verifyAccessJwt(token, { aud, teamDomain }) {
  if (!token || !aud || !teamDomain) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = b64urlDecodeJson(parts[0]);
    const payload = b64urlDecodeJson(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

    const jwk = await getKey(teamDomain, header.kid, { allowRefetch: true });
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlDecodeToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!ok) return null;

    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;
    if (payload.iss !== `https://${teamDomain}`) return null;
    if (payload.type !== 'app') return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;

    return { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit src/auth.test.js`
Expected: PASS, 12 tests.

If `crypto.subtle.exportKey('jwk')` output includes `key_ops`/`ext` fields, `importKey` still accepts them; if a test fails on import, strip `key_ops` in `fetchJwks` (`const { key_ops, ...rest } = k`).

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm format:check`
Expected: clean. If `tsc` complains that `jwk` is not `JsonWebKey`, add `/** @type {JsonWebKey} */` on the `jwk` local in `verifyAccessJwt`.

```bash
git add src/auth.js src/auth.test.js
git commit -m "feat(auth): verify Cloudflare Access JWTs with Web Crypto

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Test harness switch — stub-based auth in integration tests

Do this before touching the worker so existing suites keep a working `authed()` when the password route disappears. After this task the harness works with both old and new worker code.

**Files:**

- Modify: `src/test-utils/app.js`
- Modify: `vitest.config.js`

**Interfaces:**

- Produces:
  - `devEnv(overrides?)` → `makeEnv({ ENVIRONMENT: 'uat', AUTH_STUB_USER: 'user_local_dev', ...overrides })`
  - `asUser(id: string)` → `{ 'x-dev-user': id }` headers object
  - `authed(path, init?, env = devEnv())` — sends request under the dev stub. Signature unchanged for callers.
  - `paste(content, title, env = devEnv())` — unchanged signature.
  - `login` removed.

- [ ] **Step 1: Update `vitest.config.js` bindings**

Replace the `bindings` block:

```js
                bindings: {
                  ACCESS_AUD: 'test-aud',
                  ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
                  LOG_LEVEL: 'error',
                },
```

- [ ] **Step 2: Rewrite the auth helpers in `src/test-utils/app.js`**

Replace `login` and `authed`, and change `paste`'s default env:

```js
/** Env with the UAT stub on: every request is authenticated as AUTH_STUB_USER. */
export function devEnv(overrides = {}) {
  return makeEnv({ ENVIRONMENT: 'uat', AUTH_STUB_USER: 'user_local_dev', ...overrides });
}

/** Header that switches identity under the dev stub (ignored outside isDevEnv). */
export function asUser(id) {
  return { 'x-dev-user': id };
}

/** Sends a request as an authenticated user via the dev stub. */
export async function authed(path, init = {}, env = devEnv()) {
  return call(path, init, env);
}

/** Creates a note via /api/paste and returns its id. */
export async function paste(content, title, env = devEnv()) {
  const res = await authed('/api/paste', json({ content, title }), env);
  const body = await res.json();
  return body.id;
}
```

Delete the old `login` and `authed` functions entirely.

- [ ] **Step 3: Temporarily neutralise `src/auth.integration.test.js`**

It imports `login`, which no longer exists. Replace the whole file with a placeholder that Task 3 overwrites:

```js
import { describe, it } from 'vitest';

// Rewritten in Task 3 (Cloudflare Access JWT path).
describe.skip('auth', () => {
  it('placeholder', () => {});
});
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS. All file/folder/history/retention/spa suites run under the stub; `dev.integration.test.js` unchanged and green; auth suite skipped.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.js src/test-utils/app.js src/auth.integration.test.js
git commit -m "test: drive integration suites through the UAT auth stub

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Worker — Access middleware, `X-Dev-User`, auth routes

**Files:**

- Modify: `src/worker.js` (typedef at top; `signValue`/`verifySignedCookie` block ~lines 21–47; auth middleware + routes ~lines 234–284)
- Modify: `src/auth.integration.test.js` (rewrite)
- Modify: `src/dev.integration.test.js` (add cases)

**Interfaces:**

- Consumes: `verifyAccessJwt`, `resetJwksCache` from Task 1; `devEnv`, `asUser` from Task 2.
- Produces:
  - Hono variable `user: { id: string, email: string } | null` on every `/api/*` request.
  - `GET /api/auth/login` → 302 to `/` (or same-origin `?next=`).
  - `POST /api/auth/logout` → 200 `{ redirect: '/cdn-cgi/access/logout' }` and clears `CF_Authorization`.
  - `GET /api/auth/check` → `{ authenticated: boolean, user: {id,email} | null, stub?: string }`.
  - Env vars `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`.

- [ ] **Step 1: Write the failing integration tests**

`src/auth.integration.test.js` (full replacement):

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { call, json, makeEnv, clearAll } from './test-utils/app.js';
import { resetJwksCache } from './auth.js';

const TEAM = 'test.cloudflareaccess.com';
const AUD = 'test-aud';

function b64url(bytes) {
  const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let key;
async function setupKey() {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  key = { privateKey: pair.privateKey, jwk: { ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' } };
}

async function mint(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: 'RS256', typ: 'JWT', kid: 'k1' };
  const p = {
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: now + 3600,
    iat: now,
    type: 'app',
    sub: 'sub-alice',
    email: 'alice@example.com',
    ...claims,
  };
  const data = `${b64url(JSON.stringify(h))}.${b64url(JSON.stringify(p))}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(data)
  );
  return `${data}.${b64url(sig)}`;
}

const cookieFor = (t) => ({ cookie: `CF_Authorization=${t}` });

describe('auth (Cloudflare Access)', () => {
  beforeEach(async () => {
    await clearAll();
    resetJwksCache();
    await setupKey();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) {
          return new Response(JSON.stringify({ keys: [key.jwk] }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('unexpected fetch', { status: 500 });
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('401s protected routes without a cookie', async () => {
    expect((await call('/api/files')).status).toBe(401);
  });

  it('accepts a valid CF_Authorization cookie', async () => {
    const res = await call('/api/files', { headers: cookieFor(await mint()) });
    expect(res.status).toBe(200);
  });

  it('accepts the Cf-Access-Jwt-Assertion header', async () => {
    const res = await call('/api/files', {
      headers: { 'cf-access-jwt-assertion': await mint() },
    });
    expect(res.status).toBe(200);
  });

  it('401s an expired or tampered token', async () => {
    const expired = await mint({ exp: Math.floor(Date.now() / 1000) - 5 });
    expect((await call('/api/files', { headers: cookieFor(expired) })).status).toBe(401);
    const t = await mint();
    const tampered = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
    expect((await call('/api/files', { headers: cookieFor(tampered) })).status).toBe(401);
  });

  it('401s a token for a different audience', async () => {
    const t = await mint({ aud: ['someone-else'] });
    expect((await call('/api/files', { headers: cookieFor(t) })).status).toBe(401);
  });

  it('check reports the user', async () => {
    expect(await (await call('/api/auth/check')).json()).toEqual({
      authenticated: false,
      user: null,
    });
    const yes = await (await call('/api/auth/check', { headers: cookieFor(await mint()) })).json();
    expect(yes).toEqual({
      authenticated: true,
      user: { id: 'sub-alice', email: 'alice@example.com' },
    });
  });

  it('login redirects home and records the user', async () => {
    const env = makeEnv();
    const res = await call('/api/auth/login', { headers: cookieFor(await mint()) }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const user = JSON.parse(await env.HISTORY.get('user:sub-alice'));
    expect(user).toMatchObject({ id: 'sub-alice', email: 'alice@example.com' });
    expect(user.createdAt).toBeTruthy();
  });

  it('login honours a same-origin next path only', async () => {
    const t = await mint();
    const ok = await call('/api/auth/login?next=/abc123', { headers: cookieFor(t) });
    expect(ok.headers.get('location')).toBe('/abc123');
    const bad = await call('/api/auth/login?next=https://evil.example', {
      headers: cookieFor(t),
    });
    expect(bad.headers.get('location')).toBe('/');
    const proto = await call('/api/auth/login?next=//evil.example', { headers: cookieFor(t) });
    expect(proto.headers.get('location')).toBe('/');
  });

  it('login without a valid token still redirects home', async () => {
    const res = await call('/api/auth/login');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('logout clears the cookie and returns the Access logout URL', async () => {
    const res = await call('/api/auth/logout', json({}, { headers: cookieFor(await mint()) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: '/cdn-cgi/access/logout' });
    expect(res.headers.get('set-cookie')).toMatch(/CF_Authorization=;|Max-Age=0/i);
  });

  it('old password login route is gone', async () => {
    const res = await call('/api/auth/login', json({ password: 'x' }));
    expect(res.status).toBe(404);
  });
});
```

Append to `src/dev.integration.test.js` inside `describe('dev gate')`:

```js
it('X-Dev-User switches identity under the stub', async () => {
  const env = uat();
  const base = await (await call('/api/auth/check', {}, env)).json();
  expect(base).toEqual({
    authenticated: true,
    user: { id: 'user_local_dev', email: 'user_local_dev@dev.local' },
    stub: 'user_local_dev',
  });
  const bob = await (
    await call('/api/auth/check', { headers: { 'x-dev-user': 'bob' } }, env)
  ).json();
  expect(bob.user).toEqual({ id: 'bob', email: 'bob@dev.local' });
});

it('X-Dev-User is ignored outside the dev env', async () => {
  const prod = makeEnv({ ENVIRONMENT: 'production', AUTH_STUB_USER: 'user_local_dev' });
  const res = await call('/api/files', { headers: { 'x-dev-user': 'bob' } }, prod);
  expect(res.status).toBe(401);
  const check = await (
    await call('/api/auth/check', { headers: { 'x-dev-user': 'bob' } }, prod)
  ).json();
  expect(check).toEqual({ authenticated: false, user: null });
  const noStub = makeEnv({ ENVIRONMENT: 'uat' });
  expect((await call('/api/files', { headers: { 'x-dev-user': 'bob' } }, noStub)).status).toBe(401);
});
```

Also update the two existing `dev.integration.test.js` expectations that check `/api/auth/check` shapes:

- `'stub alone under production is ignored'`: `toEqual({ authenticated: false, user: null })`
- `'uat + stub bypasses auth and exposes seed'`: keep `toMatchObject({ authenticated: true })` (still passes).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project integration src/auth.integration.test.js src/dev.integration.test.js`
Expected: FAIL — cookie-based tests 401, `check` shape mismatch, login returns 404 for GET, logout body mismatch.

- [ ] **Step 3: Rewrite the auth section of `src/worker.js`**

Top of file — imports and typedef:

```js
import { Hono } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';
import { createLogger } from './logger.js';
import { seedScenarios } from './seed.js';
import { verifyAccessJwt } from './auth.js';

/**
 * @typedef {object} Env
 * @property {R2Bucket} MD_FILES
 * @property {KVNamespace} HISTORY
 * @property {Fetcher} ASSETS
 * @property {string} ACCESS_AUD          Access application AUD tag (wrangler var)
 * @property {string} ACCESS_TEAM_DOMAIN  e.g. myteam.cloudflareaccess.com (wrangler var)
 * @property {string} [LOG_LEVEL]
 * @property {string} [ENVIRONMENT]   'production' in wrangler.jsonc; 'uat' under env.uat
 * @property {string} [AUTH_STUB_USER] set only by scripts/uat.mjs via `wrangler dev --var`
 */

/** @typedef {{ id: string, email: string }} User */

/** @type {Hono<{ Bindings: Env, Variables: { logger: ReturnType<typeof createLogger>, user: User | null } }>} */
const app = new Hono();
```

Delete the whole `// ── Web Crypto auth helpers` block (`signValue`, `verifySignedCookie`).

Add after the folder helpers (before `// ── KV metadata scan helper`):

```js
// ── User helpers ────────────────────────────────────────────────────────────

const ACCESS_COOKIE = 'CF_Authorization';

/** Resolve the caller. Dev stub wins; otherwise verify the Access JWT. */
async function resolveUser(c) {
  if (isDevEnv(c.env)) {
    const id = c.req.header('x-dev-user') || c.env.AUTH_STUB_USER;
    return { id, email: `${id}@dev.local` };
  }
  const token = c.req.header('cf-access-jwt-assertion') || getCookie(c, ACCESS_COOKIE);
  return verifyAccessJwt(token, {
    aud: c.env.ACCESS_AUD,
    teamDomain: c.env.ACCESS_TEAM_DOMAIN,
  });
}

/** Create or touch `user:{id}`. */
async function upsertUser(kv, user) {
  const key = `user:${user.id}`;
  const now = new Date().toISOString();
  const existing = await kv.get(key);
  let record = { id: user.id, email: user.email, createdAt: now, lastSeenAt: now };
  if (existing) {
    try {
      record = { ...JSON.parse(existing), email: user.email, lastSeenAt: now };
    } catch {
      /* overwrite corrupt record */
    }
  }
  await kv.put(key, JSON.stringify(record));
  return record;
}

/** Only allow same-origin absolute paths as a post-login destination. */
function safeNext(raw) {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}
```

Note: `isDevEnv` is defined later in the file (function declarations hoist), so this compiles.

Replace the `// ── Auth middleware` block:

```js
// ── Auth middleware ──────────────────────────────────────────────────────────
// Resolves the caller on every /api/* request (dev stub → Access JWT → null).
// Only /api/auth/* is reachable anonymously; everything else 401s without a user.

app.use('/api/*', async (c, next) => {
  const user = await resolveUser(c);
  c.set('user', user);
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/auth/')) return next();
  if (!user) {
    c.get('logger').warn('auth.unauthorized', { path });
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});
```

Replace the `// ── Auth routes` block:

```js
// ── Auth routes ─────────────────────────────────────────────────────────────
// /api/auth/login is the only path gated by Cloudflare Access. Access
// authenticates, sets CF_Authorization on this domain, then forwards here.

app.get('/api/auth/login', async (c) => {
  const user = c.get('user');
  const next = safeNext(c.req.query('next'));
  if (!user) {
    c.get('logger').warn('auth.login_without_token');
    return c.redirect('/', 302);
  }
  await upsertUser(c.env.HISTORY, user);
  c.get('logger').info('auth.login', { userId: user.id });
  return c.redirect(next, 302);
});

app.post('/api/auth/logout', (c) => {
  deleteCookie(c, ACCESS_COOKIE, { path: '/' });
  c.get('logger').info('auth.logout');
  return c.json({ redirect: '/cdn-cgi/access/logout' });
});

app.get('/api/auth/check', (c) => {
  const user = c.get('user');
  const body = { authenticated: Boolean(user), user };
  if (isDevEnv(c.env)) return c.json({ ...body, stub: c.env.AUTH_STUB_USER });
  return c.json(body);
});
```

The `/api/dev/*` 404 guard middleware is registered before the auth middleware today; keep that ordering (it must stay in front so unknown `/api/dev/*` never reaches auth).

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS. If `vi.stubGlobal('fetch')` does not intercept the worker's fetch inside the workers pool, switch `src/auth.js` to call `globalThis.fetch(...)` explicitly (it should already resolve at call time); if it still fails, report back rather than adding a config seam.

- [ ] **Step 5: Lint, typecheck, format, commit**

Run: `pnpm lint && pnpm typecheck && pnpm format:check`
Expected: clean. `tsc` may flag `c.req.query('next')` as `string | undefined` — `safeNext` already accepts that.

```bash
git add src/worker.js src/auth.integration.test.js src/dev.integration.test.js
git commit -m "feat(worker): authenticate via Cloudflare Access JWT, add X-Dev-User stub override

Replaces the shared-password HMAC cookie. Closes #69.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Config — wrangler vars, UAT script, `.dev.vars`

**Files:**

- Modify: `wrangler.jsonc` (`vars` and `env.uat.vars`)
- Modify: `scripts/uat.mjs` (lines ~94–99)
- Modify: `.gitignore` check only; create `.dev.vars.example`

**Interfaces:**

- Produces: `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` present in every environment.

- [ ] **Step 1: `wrangler.jsonc`**

Top-level `vars`:

```jsonc
  "vars": {
    "LOG_LEVEL": "info",
    // Pinned so isDevEnv() can never be true in production (see src/worker.js)
    "ENVIRONMENT": "production",
    // Cloudflare Access application (Zero Trust > Access > Applications).
    // Fill in after creating the app per docs/DEPLOYMENT.md. Not secrets.
    "ACCESS_AUD": "",
    "ACCESS_TEAM_DOMAIN": "",
  },
```

`env.uat.vars`:

```jsonc
      "vars": {
        "LOG_LEVEL": "debug",
        "ENVIRONMENT": "uat",
        "ACCESS_AUD": "uat-aud",
        "ACCESS_TEAM_DOMAIN": "uat.cloudflareaccess.com",
      },
```

Empty prod values are safe: `verifyAccessJwt` returns `null` when `aud`/`teamDomain` are empty, so the app is locked (401) until #68's dashboard step fills them in.

- [ ] **Step 2: `scripts/uat.mjs`**

Remove the two `--var` pairs for `ACCESS_PASSWORD` and `COOKIE_SECRET`, leaving only `AUTH_STUB_USER`:

```js
    '--var',
    `AUTH_STUB_USER:${STUB_USER}`,
  ],
```

- [ ] **Step 3: `.dev.vars.example`**

Create:

```
# Local dev (pnpm dev). Access cannot run locally, so plain `pnpm dev` is
# anonymous. Use `pnpm uat` for an authenticated stub session.
LOG_LEVEL=debug
```

Confirm `.dev.vars` is in `.gitignore` (it is per docs/DEPLOYMENT.md).

- [ ] **Step 4: Verify UAT boots**

Run: `pnpm uat` then `curl -s http://localhost:<port>/api/auth/check` (port printed by the script), then `pnpm uat:stop`.
Expected: `{"authenticated":true,"user":{"id":"user_local_dev","email":"user_local_dev@dev.local"},"stub":"user_local_dev"}`.

- [ ] **Step 5: Commit**

```bash
git add wrangler.jsonc scripts/uat.mjs .dev.vars.example
git commit -m "chore: ACCESS_AUD/ACCESS_TEAM_DOMAIN vars, drop password secrets from UAT

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Frontend — sign-in link, logout redirect, check shape

**Files:**

- Modify: `public/index.html` (login card ~lines 26–58)
- Modify: `public/js/app.js` (element refs ~lines 42–54; auth section ~lines 316–374)
- Modify: `public/css/style.css` (`#login-form` rules ~lines 151–180 → `.login-actions`)

**Interfaces:**

- Consumes: `GET /api/auth/check` → `{ authenticated, user }`; `POST /api/auth/logout` → `{ redirect }`.

- [ ] **Step 1: `public/index.html` login card**

Replace the subtitle + form + error:

```html
<h1>Markdown Viewer</h1>
<p class="login-subtitle">Sign in to view and manage your notes</p>
<div class="login-actions">
  <a id="login-link" class="login-button" href="/api/auth/login">Sign in</a>
</div>
```

- [ ] **Step 2: `public/css/style.css`**

Replace the four `#login-form` rules (`#login-form`, `#login-form input`, `#login-form input:focus`, `#login-form button`, `#login-form button:hover`) with:

```css
.login-actions {
  display: flex;
  justify-content: center;
}

.login-button {
  display: inline-block;
  padding: 10px 24px;
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  font-size: 0.9375rem;
  font-weight: 500;
  text-decoration: none;
  transition: background 0.15s;
}

.login-button:hover {
  background: var(--accent-hover);
}
```

- [ ] **Step 3: `public/js/app.js`**

Element refs: delete `loginForm`, `loginPassword`, `loginError`; add:

```js
const loginLink = document.getElementById('login-link');
```

Auth section: replace `checkAuth`, the `loginForm` submit handler, and the logout handler:

```js
let currentUser = null;

async function checkAuth() {
  try {
    const res = await api('/api/auth/check');
    const data = await res.json();
    currentUser = data.user || null;
    if (data.authenticated) {
      showApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

function showLogin() {
  // Return to the current note after sign-in (same-origin path only; server re-validates).
  const next = location.pathname !== '/' ? `?next=${encodeURIComponent(location.pathname)}` : '';
  loginLink.href = `/api/auth/login${next}`;
  loginScreen.hidden = false;
  appScreen.hidden = true;
  stopPolling();
}

logoutBtn.addEventListener('click', async () => {
  currentUser = null;
  const res = await api('/api/auth/logout', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (data.redirect) {
    location.href = data.redirect;
  } else {
    showLogin();
  }
});
```

`showApp` unchanged. `currentUser` is unused until step 2 (#38) but is set here so the check shape is consumed in one place; leave a one-line comment saying so.

- [ ] **Step 4: Verify in the browser via UAT**

Run: `pnpm uat`, open the printed URL. Expected: app loads directly (stub), logout button POSTs and navigates to `/cdn-cgi/access/logout` (404 locally — expected; note it). Then check the anonymous path: run `pnpm dev` (no stub), open `http://localhost:8787`. Expected: login card with a single "Sign in" link pointing at `/api/auth/login`, no password field, no console errors. Stop both servers.

- [ ] **Step 5: Lint, format, commit**

Run: `pnpm lint && pnpm format:check`

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(frontend): replace password form with Cloudflare Access sign-in link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Docs + #68 operator checklist

**Files:**

- Modify: `docs/DEPLOYMENT.md` (architecture table row 13–14; "2. Set secrets" section; local `.dev.vars` section)
- Modify: `CLAUDE.md` (Auth paragraph; UAT stub paragraph)
- Modify: `.claude/skills/verifier-web/SKILL.md` only if it mentions the password (grep `ACCESS_PASSWORD`; currently it does not)

- [ ] **Step 1: `docs/DEPLOYMENT.md`**

Architecture table rows:

```
| Auth               | Cloudflare Access     | Zero Trust app on `/api/auth/login`; Worker verifies the JWT |
| Config vars        | `wrangler.jsonc` vars | `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`                       |
```

Replace "### 2. Set secrets" with:

````markdown
### 2. Create the Cloudflare Access application

Zero Trust (free plan, up to 50 users) issues the login session; the Worker only verifies it.

1. Cloudflare dashboard → Zero Trust → Access → Applications → **Add an application** → Self-hosted.
2. Application domain: `notebook.noahcancode.com`, path: `api/auth/login`. **Only this path is gated**; every other path (including shared note links) is served by the Worker directly.
3. Identity providers: enable Google and GitHub under Zero Trust → Settings → Authentication (One-time PIN optional). Select them on the application.
4. Policy: name `allow-users`, action **Allow**, include rule **Everyone** (or restrict by email). Session duration: 1 month.
5. Save, then open the application → Overview and copy the **Application Audience (AUD) Tag**.
6. Put the AUD and your team domain (`<team>.cloudflareaccess.com`, from Zero Trust → Settings → Custom Pages) into `wrangler.jsonc` `vars`:

   "ACCESS_AUD": "<aud tag>",
   "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",

   These are not secrets; commit them.

7. Delete the legacy secrets once the new build is deployed:

```bash
npx wrangler secret delete ACCESS_PASSWORD
npx wrangler secret delete COOKIE_SECRET
```
````

Until step 6 is deployed, the app returns 401 for everything except `/api/auth/*`.

````

Local dev section — replace the `.dev.vars` snippet:

```markdown
Cloudflare Access cannot run locally, so plain `pnpm dev` is anonymous (read-only once
step 2 of the auth design lands). Use `pnpm uat` for an authenticated stub session; send
`X-Dev-User: <id>` to act as a different user. `.dev.vars` (gitignored) only needs:

    LOG_LEVEL=debug
````

- [ ] **Step 2: `CLAUDE.md`**

Replace the `**Auth:**` paragraph:

```markdown
**Auth:** Cloudflare Access (Zero Trust) gates only `/api/auth/login`. Every `/api/*` request runs `resolveUser()` which verifies the `CF_Authorization` cookie (or `Cf-Access-Jwt-Assertion` header) via `src/auth.js` against `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` (wrangler vars, not secrets) and sets `c.get('user')` to `{ id, email }` or `null`. Routes outside `/api/auth/*` 401 without a user. Design: `docs/plans/2026-09-04-auth-design.md`.
```

Extend the `**UAT stub:**` paragraph with one sentence:

```markdown
Under the stub, `X-Dev-User: <id>` switches identity (integration tests use `asUser()` from `src/test-utils/app.js`); the header is ignored outside `isDevEnv`.
```

Update the API table rows:

```
| GET    | `/api/auth/login`    | Access-gated; upserts user, redirects (unprotected) |
| GET    | `/api/auth/check`    | `{ authenticated, user }` (unprotected)  |
| POST   | `/api/auth/logout`   | Clears cookie, returns Access logout URL (unprotected) |
```

- [ ] **Step 3: Run the full gate**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOYMENT.md CLAUDE.md
git commit -m "docs: Cloudflare Access setup and dev-stub identity override

Closes #68 checklist (dashboard steps are manual).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## After the plan

- Open a PR for the branch (`/commit-push-pr`). Do **not** merge until the Access application exists and `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` are filled in `wrangler.jsonc`, because merging deploys and an empty AUD locks the app.
- #68 remains open for the operator until the dashboard steps in `docs/DEPLOYMENT.md` are done and the vars committed.
- Step 2 of the design (ownership, visibility, migration) starts from `c.get('user').id`.
