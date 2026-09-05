import { describe, it, expect, beforeEach } from 'vitest';
import { env as baseEnv } from 'cloudflare:test';
import { clearAll, readJson, makeEnv } from './test-utils/app.js';
import { migrateToOwner } from './migrate.js';

const OWNER = 'sub-noah';
const legacyMeta = (filename, created) =>
  JSON.stringify({ filename, source: 'paste', size: 1, created, lastAccessedAt: created });

describe('migrateToOwner', () => {
  beforeEach(() => clearAll());

  it('stamps legacy meta, builds the index, moves history and folders, and is idempotent', async () => {
    const env = makeEnv();
    const kv = baseEnv.HISTORY;
    await kv.put('meta:a', legacyMeta('A', '2026-01-01T00:00:00.000Z'));
    await kv.put('meta:b', legacyMeta('B', '2026-02-01T00:00:00.000Z'));
    await kv.put(
      'meta:c',
      JSON.stringify({
        filename: 'C',
        ownerId: 'someone-else',
        visibility: 'private',
        created: '2026-03-01T00:00:00.000Z',
      })
    );
    await kv.put(
      'history',
      JSON.stringify([
        { id: 'b', filename: 'B', source: 'paste', viewedAt: '2026-02-02T00:00:00.000Z' },
      ])
    );
    await kv.put(
      'folders',
      JSON.stringify([
        { id: 'f-1', name: 'F', fileIds: ['a'], created: '2026-01-05T00:00:00.000Z' },
      ])
    );

    const r1 = await migrateToOwner(kv, OWNER);
    expect(r1).toEqual({
      stamped: 2,
      skipped: 1,
      missing: 0,
      indexed: 2,
      movedHistory: true,
      movedFolders: true,
    });
    expect(await readJson(env, 'meta:a')).toMatchObject({
      ownerId: OWNER,
      visibility: 'link',
      editors: [],
      currentRev: 0,
    });
    expect((await readJson(env, 'meta:c')).ownerId).toBe('someone-else');
    expect(await readJson(env, `user:${OWNER}:notes`)).toEqual(['b', 'a']);
    expect((await readJson(env, `history:${OWNER}`)).map((h) => h.id)).toEqual(['b']);
    expect((await readJson(env, `folders:${OWNER}`)).map((f) => f.id)).toEqual(['f-1']);
    expect(await kv.get('history')).toBeNull();
    expect(await kv.get('folders')).toBeNull();

    const r2 = await migrateToOwner(kv, OWNER);
    expect(r2).toEqual({
      stamped: 0,
      skipped: 3,
      missing: 0,
      indexed: 0,
      movedHistory: false,
      movedFolders: false,
    });
    expect(await readJson(env, `user:${OWNER}:notes`)).toEqual(['b', 'a']);
  });

  it('merges into an existing per-user index/history without duplicates', async () => {
    const env = makeEnv();
    const kv = baseEnv.HISTORY;
    await kv.put('meta:old', legacyMeta('Old', '2026-01-01T00:00:00.000Z'));
    await kv.put(
      'meta:new',
      JSON.stringify({
        filename: 'New',
        ownerId: OWNER,
        visibility: 'private',
        created: '2026-04-01T00:00:00.000Z',
      })
    );
    await kv.put(`user:${OWNER}:notes`, JSON.stringify(['new']));
    await kv.put(
      `history:${OWNER}`,
      JSON.stringify([{ id: 'new', filename: 'New', viewedAt: '2026-04-02T00:00:00.000Z' }])
    );
    await kv.put(
      'history',
      JSON.stringify([
        { id: 'old', filename: 'Old', viewedAt: '2026-01-02T00:00:00.000Z' },
        { id: 'new', filename: 'New', viewedAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    await migrateToOwner(kv, OWNER);
    expect(await readJson(env, `user:${OWNER}:notes`)).toEqual(['new', 'old']);
    expect((await readJson(env, `history:${OWNER}`)).map((h) => h.id)).toEqual(['new', 'old']);
  });
  it('re-run self-heals: meta already stamped but missing from the index gets indexed', async () => {
    const env = makeEnv();
    const kv = baseEnv.HISTORY;
    await kv.put(
      'meta:x',
      JSON.stringify({
        filename: 'X',
        ownerId: OWNER,
        visibility: 'link',
        created: '2026-05-01T00:00:00.000Z',
      })
    );
    await kv.put('meta:y', legacyMeta('Y', '2026-06-01T00:00:00.000Z'));
    const r = await migrateToOwner(kv, OWNER);
    expect(r).toMatchObject({ stamped: 1, skipped: 1, missing: 0, indexed: 2 });
    expect(await readJson(env, `user:${OWNER}:notes`)).toEqual(['y', 'x']);
  });

  it('aborts before any write when a per-user read fails', async () => {
    const kv = baseEnv.HISTORY;
    await kv.put('meta:a', legacyMeta('A', '2026-01-01T00:00:00.000Z'));
    await kv.put(
      'history',
      JSON.stringify([{ id: 'a', filename: 'A', viewedAt: '2026-01-02T00:00:00.000Z' }])
    );
    let failed = false;
    const flaky = {
      list: (o) => kv.list(o),
      put: (k, v) => kv.put(k, v),
      delete: (k) => kv.delete(k),
      get: async (k) => {
        if (k === `history:${OWNER}` && !failed) {
          failed = true;
          throw new Error('transient');
        }
        return kv.get(k);
      },
    };
    await expect(migrateToOwner(flaky, OWNER)).rejects.toThrow('transient');
    expect(await kv.get('history')).not.toBeNull();
    expect(await kv.get(`history:${OWNER}`)).toBeNull();
  });
});
