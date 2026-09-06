import { describe, it, expect, beforeEach } from 'vitest';
import {
  call,
  authed,
  json,
  devEnv,
  paste,
  clearAll,
  asUser,
  readJson,
  runScheduled,
} from './test-utils/app.js';

const alice = () => devEnv({ AUTH_STUB_USER: 'alice' });
const bob = { headers: asUser('bob') };
const put = (env, id, body, extra = {}) =>
  authed(`/api/files/${id}`, json(body, { method: 'PUT', ...extra }), env);
const share = (env, id) =>
  authed(`/api/files/${id}/visibility`, json({ visibility: 'link' }, { method: 'PATCH' }), env);

describe('revisions', () => {
  beforeEach(() => clearAll());

  it('first edit snapshots rev 0, writes rev 1, updates current content and meta', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    const res = await put(env, id, { content: 'v1', message: '  first  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      currentRev: 1,
      revision: { n: 1, by: 'alice@dev.local', message: 'first', bytes: 2 },
    });
    expect(await (await env.MD_FILES.get(`${id}.md`)).text()).toBe('v1');
    expect(await (await env.MD_FILES.get(`${id}/r/0.md`)).text()).toBe('v0');
    expect(await (await env.MD_FILES.get(`${id}/r/1.md`)).text()).toBe('v1');
    const meta = await readJson(env, `meta:${id}`);
    expect(meta).toMatchObject({ currentRev: 1, size: 2 });
    const revs = await readJson(env, `rev:${id}`);
    expect(revs.map((r) => r.n)).toEqual([1, 0]);
    expect(revs[1]).toMatchObject({ n: 0, message: 'Original', bytes: 2, at: meta.created });
    const file = await (await authed(`/api/files/${id}`, {}, env)).json();
    expect(file).toMatchObject({ content: 'v1', currentRev: 1 });
  });

  it('validates the body', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    expect((await put(env, id, { content: 'v0' })).status).toBe(400); // unchanged
    expect((await put(env, id, { content: '' })).status).toBe(400);
    expect((await put(env, id, { content: 42 })).status).toBe(400);
    expect((await put(env, id, { content: 'x'.repeat(2 * 1024 * 1024 + 1) })).status).toBe(400);
    const long = await put(env, id, { content: 'v1', message: 'm'.repeat(300) });
    expect((await long.json()).revision.message).toHaveLength(200);
    expect(await readJson(env, `rev:${id}`)).toHaveLength(2);
  });

  it('is owner-only: bob and anonymous get 404 and nothing changes', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    await share(env, id);
    expect((await put(env, id, { content: 'hack' }, bob)).status).toBe(404);
    expect(
      (await call(`/api/files/${id}`, json({ content: 'hack' }, { method: 'PUT' }))).status
    ).toBe(401);
    expect(await (await env.MD_FILES.get(`${id}.md`)).text()).toBe('v0');
    expect(await env.HISTORY.get(`rev:${id}`)).toBeNull();
  });

  it('lists and serves revisions under the read rules', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    await put(env, id, { content: 'v1' });
    await put(env, id, { content: 'v2', message: 'two' });

    // private: owner yes, bob/anon 404
    const mine = await (await authed(`/api/files/${id}/revisions`, {}, env)).json();
    expect(mine.map((r) => r.n)).toEqual([2, 1, 0]);
    expect((await authed(`/api/files/${id}/revisions`, bob, env)).status).toBe(404);
    expect((await call(`/api/files/${id}/revisions`)).status).toBe(404);
    expect((await call(`/api/files/${id}/revisions/1`)).status).toBe(404);

    await share(env, id);
    const anonList = await call(`/api/files/${id}/revisions`);
    expect(anonList.status).toBe(200);
    const snap = await call(`/api/files/${id}/revisions/1`);
    expect(snap.status).toBe(200);
    expect(snap.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(await snap.text()).toBe('v1');
    expect(await (await call(`/api/files/${id}/revisions/0`)).text()).toBe('v0');
    expect((await call(`/api/files/${id}/revisions/9`)).status).toBe(404);
    expect((await call(`/api/files/${id}/revisions/abc`)).status).toBe(404);
    // no edits yet → empty list, and rev 0 is not served until it exists
    const fresh = await paste('f', 'Fresh', env);
    await share(env, fresh);
    expect(await (await call(`/api/files/${fresh}/revisions`)).json()).toEqual([]);
    expect((await call(`/api/files/${fresh}/revisions/0`)).status).toBe(404);
  });

  it('caps the log at 100 and deletes the evicted snapshot', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    for (let i = 1; i <= 100; i++) await put(env, id, { content: `v${i}` });
    // entries: 100..1 plus 0 = 101 → oldest (0) evicted
    const revs = await readJson(env, `rev:${id}`);
    expect(revs).toHaveLength(100);
    expect(revs[0].n).toBe(100);
    expect(revs[99].n).toBe(1);
    expect(await env.MD_FILES.get(`${id}/r/0.md`)).toBeNull();
    expect(await env.MD_FILES.get(`${id}/r/1.md`)).not.toBeNull();
  }, 30000);

  it('rename does not create a revision', async () => {
    const env = alice();
    const id = await paste('v0', 'Note', env);
    await authed(`/api/files/${id}`, json({ filename: 'Renamed' }, { method: 'PATCH' }), env);
    expect(await env.HISTORY.get(`rev:${id}`)).toBeNull();
    expect((await readJson(env, `meta:${id}`)).currentRev).toBe(0);
  });

  it('deleting a note purges snapshots and the log (route, folder delete, retention)', async () => {
    const env = alice();
    const a = await paste('a0', 'A', env);
    await put(env, a, { content: 'a1' });
    await authed(`/api/files/${a}`, { method: 'DELETE' }, env);
    expect(await env.MD_FILES.get(`${a}/r/0.md`)).toBeNull();
    expect(await env.MD_FILES.get(`${a}/r/1.md`)).toBeNull();
    expect(await env.HISTORY.get(`rev:${a}`)).toBeNull();

    const b = await paste('b0', 'B', env);
    await put(env, b, { content: 'b1' });
    const folder = await (await authed('/api/folders', json({ name: 'F' }), env)).json();
    await authed(`/api/folders/${folder.id}/files`, json({ fileId: b }), env);
    await authed(`/api/folders/${folder.id}`, { method: 'DELETE' }, env);
    expect(await env.MD_FILES.get(`${b}/r/1.md`)).toBeNull();
    expect(await env.HISTORY.get(`rev:${b}`)).toBeNull();

    const c = await paste('c0', 'C', env);
    await put(env, c, { content: 'c1' });
    const meta = await readJson(env, `meta:${c}`);
    meta.lastAccessedAt = new Date(Date.now() - 61 * 24 * 3600 * 1000).toISOString();
    await env.HISTORY.put(`meta:${c}`, JSON.stringify(meta));
    await runScheduled(env);
    expect(await env.MD_FILES.get(`${c}.md`)).toBeNull();
    expect(await env.MD_FILES.get(`${c}/r/1.md`)).toBeNull();
    expect(await env.HISTORY.get(`rev:${c}`)).toBeNull();
  });

  it('upload and paste reject content over the size cap', async () => {
    const env = alice();
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    expect((await authed('/api/paste', json({ content: big }), env)).status).toBe(400);
    const form = new FormData();
    form.append('file', new File([big], 'big.md', { type: 'text/markdown' }));
    expect((await authed('/api/upload', { method: 'POST', body: form }, env)).status).toBe(400);
  });
});
