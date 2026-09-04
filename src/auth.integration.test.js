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
