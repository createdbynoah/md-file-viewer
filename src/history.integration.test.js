import { describe, it, expect, beforeEach } from 'vitest';
import { authed, devEnv, paste, clearAll } from './test-utils/app.js';

describe('history', () => {
  beforeEach(() => clearAll());

  it('dedupes by id and orders most-recent first', async () => {
    const env = devEnv();
    const a = await paste('a', 'A', env);
    const b = await paste('b', 'B', env);
    await authed(`/api/files/${a}`, {}, env);
    const history = await (await authed('/api/history', {}, env)).json();
    expect(history.map((h) => h.id)).toEqual([a, b]);
    expect(history[0]).toHaveProperty('folderId', null);
  });

  it('caps at 100 entries', async () => {
    const env = devEnv();
    const seed = Array.from({ length: 100 }, (_, i) => ({
      id: `old-${i}`,
      filename: `o${i}`,
      source: 'paste',
      viewedAt: '2020-01-01T00:00:00.000Z',
    }));
    await env.HISTORY.put('history', JSON.stringify(seed));
    const id = await paste('n', 'New', env);
    const history = JSON.parse(await env.HISTORY.get('history'));
    expect(history).toHaveLength(100);
    expect(history[0].id).toBe(id);
    expect(history.at(-1).id).toBe('old-98');
  });

  it('hides entries whose meta is missing or archived', async () => {
    const env = devEnv();
    const a = await paste('a', 'A', env);
    const b = await paste('b', 'B', env);
    await env.HISTORY.delete(`meta:${a}`);
    const meta = JSON.parse(await env.HISTORY.get(`meta:${b}`));
    meta.archivedAt = 'x';
    await env.HISTORY.put(`meta:${b}`, JSON.stringify(meta));
    expect(await (await authed('/api/history', {}, env)).json()).toEqual([]);
  });

  it('removes a single entry and clears all', async () => {
    const env = devEnv();
    const a = await paste('a', 'A', env);
    const b = await paste('b', 'B', env);
    await authed(`/api/history/${a}`, { method: 'DELETE' }, env);
    expect((await (await authed('/api/history', {}, env)).json()).map((h) => h.id)).toEqual([b]);
    await authed('/api/history', { method: 'DELETE' }, env);
    expect(await (await authed('/api/history', {}, env)).json()).toEqual([]);
    // meta + content survive a history clear
    expect(await env.MD_FILES.get(`${b}.md`)).not.toBeNull();
  });
});
