import { describe, it, expect, beforeEach } from 'vitest';
import { call, authed, json, devEnv, paste, clearAll, asUser, readJson } from './test-utils/app.js';

const alice = () => devEnv({ AUTH_STUB_USER: 'alice' });
const bob = { headers: asUser('bob') };

async function setVisibility(env, id, visibility) {
  const res = await authed(
    `/api/files/${id}/visibility`,
    json({ visibility }, { method: 'PATCH' }),
    env
  );
  return res;
}

describe('ownership + visibility', () => {
  beforeEach(() => clearAll());

  it('private note: owner reads (owned:true), bob and anon get 404', async () => {
    const env = alice();
    const id = await paste('secret', 'S', env);
    const mine = await (await authed(`/api/files/${id}`, {}, env)).json();
    expect(mine).toMatchObject({ id, owned: true, visibility: 'private', content: 'secret' });
    expect((await authed(`/api/files/${id}`, bob, env)).status).toBe(404);
    // anonymous: base env has no stub → resolveUser() is null (ACCESS vars point nowhere)
    expect((await call(`/api/files/${id}`)).status).toBe(404);
  });

  it('link note: anyone can read, owned reflects the caller', async () => {
    const env = alice();
    const id = await paste('shared', 'L', env);
    const res = await setVisibility(env, id, 'link');
    expect(await res.json()).toEqual({ id, visibility: 'link' });

    const bobView = await (await authed(`/api/files/${id}`, bob, env)).json();
    expect(bobView).toMatchObject({ owned: false, visibility: 'link', content: 'shared' });
    const anon = await call(`/api/files/${id}`);
    expect(anon.status).toBe(200);
    expect(await anon.json()).toMatchObject({ owned: false, visibility: 'link' });
  });

  it('reads append history only for the authenticated viewer', async () => {
    const env = alice();
    const id = await paste('shared', 'L', env);
    await setVisibility(env, id, 'link');
    await env.HISTORY.put('history:alice', '[]');
    await authed(`/api/files/${id}`, bob, env);
    await call(`/api/files/${id}`);
    expect((await readJson(env, 'history:bob')).map((h) => h.id)).toEqual([id]);
    expect(await readJson(env, 'history:alice')).toEqual([]);
  });

  it('visibility endpoint validates and is owner-only', async () => {
    const env = alice();
    const id = await paste('x', 'X', env);
    expect((await setVisibility(env, id, 'public')).status).toBe(400);
    const bobTry = await authed(
      `/api/files/${id}/visibility`,
      json({ visibility: 'link' }, { method: 'PATCH', ...bob }),
      env
    );
    expect(bobTry.status).toBe(404);
    expect((await readJson(env, `meta:${id}`)).visibility).toBe('private');
    expect(
      (await call(`/api/files/${id}/visibility`, json({ visibility: 'link' }, { method: 'PATCH' })))
        .status
    ).toBe(401);
  });

  it('rename and delete are owner-only (404 for bob), even on link notes', async () => {
    const env = alice();
    const id = await paste('x', 'X', env);
    await setVisibility(env, id, 'link');
    expect(
      (await authed(`/api/files/${id}`, json({ filename: 'Y' }, { method: 'PATCH', ...bob }), env))
        .status
    ).toBe(404);
    expect((await authed(`/api/files/${id}`, { method: 'DELETE', ...bob }, env)).status).toBe(404);
    expect(await env.MD_FILES.get(`${id}.md`)).not.toBeNull();
    expect((await authed(`/api/files/${id}`, { method: 'DELETE' }, env)).status).toBe(200);
    expect(await readJson(env, 'user:alice:notes')).toEqual([]);
  });

  it('folders: bob cannot file alice’s note into his folder', async () => {
    const env = alice();
    const id = await paste('x', 'X', env);
    const folder = await (await authed('/api/folders', json({ name: 'B' }, bob), env)).json();
    const res = await authed(`/api/folders/${folder.id}/files`, json({ fileId: id }, bob), env);
    expect(res.status).toBe(404);
    expect((await readJson(env, `meta:${id}`)).folderId).toBeUndefined();
  });

  it('history hides notes the viewer can no longer read', async () => {
    const env = alice();
    const id = await paste('x', 'X', env);
    await setVisibility(env, id, 'link');
    await authed(`/api/files/${id}`, bob, env);
    expect((await (await authed('/api/history', bob, env)).json()).map((h) => h.id)).toEqual([id]);
    await setVisibility(env, id, 'private');
    expect(await (await authed('/api/history', bob, env)).json()).toEqual([]);
  });

  it('legacy note without ownerId: readable by any authed user, writable by none', async () => {
    const env = alice();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await env.MD_FILES.put(`${id}.md`, 'old');
    await env.HISTORY.put(
      `meta:${id}`,
      JSON.stringify({
        filename: 'Old',
        source: 'paste',
        size: 3,
        created: '2026-01-01T00:00:00.000Z',
      })
    );
    expect((await authed(`/api/files/${id}`, {}, env)).status).toBe(200);
    expect((await authed(`/api/files/${id}`, bob, env)).status).toBe(200);
    expect((await call(`/api/files/${id}`)).status).toBe(404);
    expect(
      (await authed(`/api/files/${id}`, json({ filename: 'N' }, { method: 'PATCH' }), env)).status
    ).toBe(404);
  });
});
