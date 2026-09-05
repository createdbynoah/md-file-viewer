// Guardrail tests for the UAT auth stub + /api/dev/* routes. If these fail,
// the bypass may be reachable in production. Keep them green.
import { describe, it, expect, beforeEach } from 'vitest';
import { call, makeEnv, clearAll } from './test-utils/app.js';

const uat = () => makeEnv({ ENVIRONMENT: 'uat', AUTH_STUB_USER: 'user_local_dev' });

describe('dev gate', () => {
  beforeEach(() => clearAll());

  it('base test env has no stub and pins production semantics', async () => {
    expect((await call('/api/dev/seed', { method: 'POST' })).status).toBe(404);
    expect((await call('/api/files')).status).toBe(401);
  });

  it('stub alone under production is ignored', async () => {
    const env = makeEnv({ ENVIRONMENT: 'production', AUTH_STUB_USER: 'user_local_dev' });
    expect((await call('/api/dev/seed', { method: 'POST' }, env)).status).toBe(404);
    expect((await call('/api/files', {}, env)).status).toBe(401);
    expect(await (await call('/api/auth/check', {}, env)).json()).toEqual({
      authenticated: false,
      user: null,
    });
  });

  it('non-production env without a stub is still locked', async () => {
    const env = makeEnv({ ENVIRONMENT: 'uat' });
    expect((await call('/api/dev/seed', { method: 'POST' }, env)).status).toBe(404);
    expect((await call('/api/files', {}, env)).status).toBe(401);
  });

  it('uat + stub bypasses auth and exposes seed', async () => {
    const env = uat();
    expect(await (await call('/api/auth/check', {}, env)).json()).toMatchObject({
      authenticated: true,
    });
    const seed = await call('/api/dev/seed', { method: 'POST' }, env);
    expect(seed.status).toBe(200);
    expect(await seed.json()).toMatchObject({ ok: true, notes: 9, folders: 3 });
    const files = await (await call('/api/files', {}, env)).json();
    // TODO(step2 task 3): seed writes legacy keys — restore 7 / [2, 1, 0] once
    // the seed writes per-user history/folders and the owner note index.
    expect(files).toHaveLength(0);
    const folders = await (await call('/api/folders', {}, env)).json();
    expect(folders.map((f) => f.files.length)).toEqual([]);
  });

  it('seed is idempotent and retention can be triggered', async () => {
    const env = uat();
    await call('/api/dev/seed', { method: 'POST' }, env);
    await call('/api/dev/seed', { method: 'POST' }, env);
    // TODO(step2 task 3): seed writes legacy keys — restore 7 once the seed
    // writes per-user history/folders and the owner note index.
    expect(await (await call('/api/files', {}, env)).json()).toHaveLength(0);
    expect((await call('/api/dev/retention', { method: 'POST' }, env)).status).toBe(200);
    expect(await (await call('/api/files', {}, env)).json()).toHaveLength(0);
  });

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
    expect((await call('/api/files', { headers: { 'x-dev-user': 'bob' } }, noStub)).status).toBe(
      401
    );
  });
});
