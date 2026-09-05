import { describe, it, expect, beforeEach } from 'vitest';
import { authed, json, devEnv, paste, clearAll } from './test-utils/app.js';

async function createFolder(name, env) {
  return (await authed('/api/folders', json({ name }), env)).json();
}

describe('folders', () => {
  beforeEach(() => clearAll());

  it('creates, renames, lists with enriched files', async () => {
    const env = devEnv();
    expect((await authed('/api/folders', json({ name: ' ' }), env)).status).toBe(400);
    const f = await createFolder('Work', env);
    expect(f.id).toMatch(/^f-[0-9a-f]{8}$/);
    const id = await paste('x', 'Doc', env);
    await authed(`/api/folders/${f.id}/files`, json({ fileId: id }), env);
    await authed(`/api/folders/${f.id}`, json({ name: 'Play' }, { method: 'PATCH' }), env);
    const list = await (await authed('/api/folders', {}, env)).json();
    expect(list).toEqual([
      expect.objectContaining({
        id: f.id,
        name: 'Play',
        files: [expect.objectContaining({ id, filename: 'Doc' })],
      }),
    ]);
    expect(JSON.parse(await env.HISTORY.get(`meta:${id}`)).folderId).toBe(f.id);
  });

  it('adding a file to a folder removes it from any other folder', async () => {
    const env = devEnv();
    const a = await createFolder('A', env);
    const b = await createFolder('B', env);
    const id = await paste('x', 'Doc', env);
    await authed(`/api/folders/${a.id}/files`, json({ fileId: id }), env);
    await authed(`/api/folders/${b.id}/files`, json({ fileId: id }), env);
    const folders = JSON.parse(await env.HISTORY.get('folders:user_local_dev'));
    expect(folders.find((f) => f.id === a.id).fileIds).toEqual([]);
    expect(folders.find((f) => f.id === b.id).fileIds).toEqual([id]);
  });

  it('404s on unknown folder or file', async () => {
    const env = devEnv();
    const f = await createFolder('A', env);
    expect((await authed('/api/folders/f-nope/files', json({ fileId: 'x' }), env)).status).toBe(
      404
    );
    expect(
      (await authed(`/api/folders/${f.id}/files`, json({ fileId: 'missing' }), env)).status
    ).toBe(404);
    expect((await authed('/api/folders/f-nope', { method: 'DELETE' }, env)).status).toBe(404);
  });

  it('removing a file from a folder clears its folderId', async () => {
    const env = devEnv();
    const f = await createFolder('A', env);
    const id = await paste('x', 'Doc', env);
    await authed(`/api/folders/${f.id}/files`, json({ fileId: id }), env);
    await authed(`/api/folders/${f.id}/files/${id}`, { method: 'DELETE' }, env);
    expect(JSON.parse(await env.HISTORY.get(`meta:${id}`)).folderId).toBeUndefined();
    expect(await env.MD_FILES.get(`${id}.md`)).not.toBeNull();
  });

  it('move transfers the file and updates meta', async () => {
    const env = devEnv();
    const a = await createFolder('A', env);
    const b = await createFolder('B', env);
    const id = await paste('x', 'Doc', env);
    await authed(`/api/folders/${a.id}/files`, json({ fileId: id }), env);
    const res = await authed(
      `/api/folders/${a.id}/files/${id}/move`,
      json({ targetFolderId: b.id }),
      env
    );
    expect(res.status).toBe(200);
    const folders = JSON.parse(await env.HISTORY.get('folders:user_local_dev'));
    expect(folders.find((f) => f.id === a.id).fileIds).toEqual([]);
    expect(folders.find((f) => f.id === b.id).fileIds).toEqual([id]);
    expect(JSON.parse(await env.HISTORY.get(`meta:${id}`)).folderId).toBe(b.id);
  });

  it('deleting a folder deletes its files, meta and history entries', async () => {
    const env = devEnv();
    const f = await createFolder('A', env);
    const keep = await paste('k', 'Keep', env);
    const gone = await paste('g', 'Gone', env);
    await authed(`/api/folders/${f.id}/files`, json({ fileId: gone }), env);
    await authed(`/api/folders/${f.id}`, { method: 'DELETE' }, env);
    expect(await env.MD_FILES.get(`${gone}.md`)).toBeNull();
    expect(await env.HISTORY.get(`meta:${gone}`)).toBeNull();
    expect(await env.MD_FILES.get(`${keep}.md`)).not.toBeNull();
    expect(JSON.parse(await env.HISTORY.get('history:user_local_dev')).map((h) => h.id)).toEqual([
      keep,
    ]);
    expect(JSON.parse(await env.HISTORY.get('folders:user_local_dev'))).toEqual([]);
  });
});
