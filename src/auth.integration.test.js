import { describe, it, expect, beforeEach } from 'vitest';
import { call, login, json, makeEnv, clearAll } from './test-utils/app.js';

describe('auth', () => {
  beforeEach(() => clearAll());

  it('rejects a wrong password', async () => {
    const { res } = await login(makeEnv(), 'nope');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sets an httpOnly signed cookie on success', async () => {
    const { res, cookie } = await login();
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/^auth=authenticated\.[0-9a-f]{64}$/);
  });

  it('401s protected routes without a cookie', async () => {
    const res = await call('/api/files');
    expect(res.status).toBe(401);
  });

  it('401s a tampered cookie', async () => {
    const { cookie } = await login();
    const tampered = cookie.replace(/.$/, (ch) => (ch === '0' ? '1' : '0'));
    const res = await call('/api/files', { headers: { cookie: tampered } });
    expect(res.status).toBe(401);
  });

  it('401s a cookie signed with a different secret', async () => {
    const other = makeEnv({ COOKIE_SECRET: 'other' });
    const { cookie } = await login(other);
    const res = await call('/api/files', { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  it('reports auth state on /api/auth/check without auth', async () => {
    const anon = await (await call('/api/auth/check')).json();
    expect(anon).toEqual({ authenticated: false });
    const { cookie } = await login();
    const yes = await (await call('/api/auth/check', { headers: { cookie } })).json();
    expect(yes).toEqual({ authenticated: true });
  });

  it('logout clears the cookie', async () => {
    const { cookie } = await login();
    const res = await call('/api/auth/logout', json({}, { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/auth=;|Max-Age=0/i);
  });
});
