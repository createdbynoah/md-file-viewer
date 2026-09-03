import { describe, it, expect, beforeEach } from 'vitest';
import { authed, json, makeEnv, paste, clearAll } from './test-utils/app.js';

describe('files', () => {
  beforeEach(() => clearAll());

  it('paste stores content, meta and history', async () => {
    const env = makeEnv();
    const id = await paste('# Hi', 'Note A', env);
    expect(await (await env.MD_FILES.get(`${id}.md`)).text()).toBe('# Hi');
    const meta = JSON.parse(await env.HISTORY.get(`meta:${id}`));
    expect(meta).toMatchObject({ filename: 'Note A', source: 'paste', size: 4 });
    const history = JSON.parse(await env.HISTORY.get('history'));
    expect(history[0]).toMatchObject({ id, filename: 'Note A' });
  });

  it('paste rejects empty content and defaults the title', async () => {
    const bad = await authed('/api/paste', json({ content: '' }));
    expect(bad.status).toBe(400);
    const ok = await authed('/api/paste', json({ content: 'x' }));
    expect((await ok.json()).filename).toBe('Pasted Markdown');
  });

  it('upload accepts .md multipart and rejects others', async () => {
    const form = new FormData();
    form.append('file', new File(['# up'], 'doc.md', { type: 'text/markdown' }));
    const res = await authed('/api/upload', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ filename: 'doc.md' });

    const bad = new FormData();
    bad.append('file', new File(['x'], 'doc.txt'));
    expect((await authed('/api/upload', { method: 'POST', body: bad })).status).toBe(400);

    const none = new FormData();
    expect((await authed('/api/upload', { method: 'POST', body: none })).status).toBe(400);
  });

  it('lists non-archived files and hides archived ones', async () => {
    const env = makeEnv();
    const a = await paste('a', 'A', env);
    const b = await paste('b', 'B', env);
    const meta = JSON.parse(await env.HISTORY.get(`meta:${b}`));
    meta.archivedAt = new Date().toISOString();
    await env.HISTORY.put(`meta:${b}`, JSON.stringify(meta));

    const files = await (await authed('/api/files', {}, env)).json();
    expect(files.map((f) => f.id)).toEqual([a]);
  });

  it('get returns content, records history, and refreshes lastAccessedAt', async () => {
    const env = makeEnv();
    const id = await paste('body', 'T', env);
    const stale = JSON.parse(await env.HISTORY.get(`meta:${id}`));
    stale.lastAccessedAt = '2000-01-01T00:00:00.000Z';
    stale.archivedAt = '2000-02-01T00:00:00.000Z';
    await env.HISTORY.put(`meta:${id}`, JSON.stringify(stale));
    await env.HISTORY.put('history', '[]');

    const res = await authed(`/api/files/${id}`, {}, env);
    expect(await res.json()).toMatchObject({ id, filename: 'T', content: 'body' });
    const meta = JSON.parse(await env.HISTORY.get(`meta:${id}`));
    expect(meta.lastAccessedAt > '2020').toBe(true);
    expect(meta.archivedAt).toBeUndefined();
    const history = JSON.parse(await env.HISTORY.get('history'));
    expect(history[0].id).toBe(id);
  });

  it('get 404s unknown ids', async () => {
    expect((await authed('/api/files/nope')).status).toBe(404);
  });

  it('rename updates meta and history; validates input', async () => {
    const env = makeEnv();
    const id = await paste('x', 'Old', env);
    expect(
      (await authed(`/api/files/${id}`, json({ filename: '  ' }, { method: 'PATCH' }), env)).status
    ).toBe(400);
    expect(
      (await authed('/api/files/nope', json({ filename: 'N' }, { method: 'PATCH' }), env)).status
    ).toBe(404);
    const res = await authed(
      `/api/files/${id}`,
      json({ filename: ' New ' }, { method: 'PATCH' }),
      env
    );
    expect(await res.json()).toEqual({ id, filename: 'New' });
    expect(JSON.parse(await env.HISTORY.get(`meta:${id}`)).filename).toBe('New');
    expect(JSON.parse(await env.HISTORY.get('history'))[0].filename).toBe('New');
  });

  it('delete removes R2 object, meta, history entry and folder refs', async () => {
    const env = makeEnv();
    const id = await paste('x', 'D', env);
    await env.HISTORY.put(
      'folders',
      JSON.stringify([{ id: 'f-1', name: 'F', fileIds: [id], created: '' }])
    );
    const res = await authed(`/api/files/${id}`, { method: 'DELETE' }, env);
    expect(res.status).toBe(200);
    expect(await env.MD_FILES.get(`${id}.md`)).toBeNull();
    expect(await env.HISTORY.get(`meta:${id}`)).toBeNull();
    expect(JSON.parse(await env.HISTORY.get('history'))).toEqual([]);
    expect(JSON.parse(await env.HISTORY.get('folders'))[0].fileIds).toEqual([]);
  });
});
