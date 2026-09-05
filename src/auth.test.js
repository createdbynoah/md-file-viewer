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
