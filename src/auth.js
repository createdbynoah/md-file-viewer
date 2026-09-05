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
      /** @type {JsonWebKey} */ (jwk),
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
