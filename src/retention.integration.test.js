import { describe, it, expect, beforeEach } from 'vitest';
import { devEnv, paste, runScheduled, clearAll, authed, json } from './test-utils/app.js';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

async function setAccessed(env, id, daysOld, extra = {}) {
  const meta = JSON.parse(await env.HISTORY.get(`meta:${id}`));
  await env.HISTORY.put(
    `meta:${id}`,
    JSON.stringify({ ...meta, lastAccessedAt: daysAgo(daysOld), ...extra })
  );
}

describe('retention cron', () => {
  beforeEach(() => clearAll());

  it('archives after 30 days, deletes after 60, leaves fresh files alone', async () => {
    const env = devEnv();
    const fresh = await paste('f', 'Fresh', env);
    const old = await paste('o', 'Old', env);
    const ancient = await paste('a', 'Ancient', env);
    await setAccessed(env, old, 31);
    await setAccessed(env, ancient, 61);

    await runScheduled(env);

    expect(JSON.parse(await env.HISTORY.get(`meta:${fresh}`)).archivedAt).toBeUndefined();
    expect(JSON.parse(await env.HISTORY.get(`meta:${old}`)).archivedAt).toBeDefined();
    expect(await env.MD_FILES.get(`${old}.md`)).not.toBeNull();
    expect(await env.HISTORY.get(`meta:${ancient}`)).toBeNull();
    expect(await env.MD_FILES.get(`${ancient}.md`)).toBeNull();
    const history = JSON.parse(await env.HISTORY.get('history:user_local_dev')).map((h) => h.id);
    expect(history).toContain(old);
    expect(history).not.toContain(ancient);
  });

  it('exempts files in an existing folder and clears stale folder refs', async () => {
    const env = devEnv();
    const inFolder = await paste('i', 'In', env);
    const stale = await paste('s', 'Stale', env);
    await env.HISTORY.put(
      'folders:user_local_dev',
      JSON.stringify([{ id: 'f-live', name: 'L', fileIds: [inFolder], created: '' }])
    );
    await setAccessed(env, inFolder, 90, { folderId: 'f-live' });
    await setAccessed(env, stale, 31, { folderId: 'f-dead' });

    await runScheduled(env);

    expect(await env.HISTORY.get(`meta:${inFolder}`)).not.toBeNull();
    const staleMeta = JSON.parse(await env.HISTORY.get(`meta:${stale}`));
    expect(staleMeta.folderId).toBeUndefined();
    expect(staleMeta.archivedAt).toBeDefined();
  });

  it('is idempotent: does not re-stamp archivedAt', async () => {
    const env = devEnv();
    const id = await paste('x', 'X', env);
    await setAccessed(env, id, 31, { archivedAt: '2001-01-01T00:00:00.000Z' });
    await runScheduled(env);
    expect(JSON.parse(await env.HISTORY.get(`meta:${id}`)).archivedAt).toBe(
      '2001-01-01T00:00:00.000Z'
    );
  });

  it('folder exemption is per owner; deletion prunes owner history and index', async () => {
    const env = devEnv();
    const mine = await paste('m', 'Mine', env);
    const bobsEnv = devEnv({ AUTH_STUB_USER: 'bob' });
    const bobs = await paste('b', 'Bobs', bobsEnv);
    // bob puts his note in a folder → exempt; mine is bare → deleted at 61d
    const folder = await (await authed('/api/folders', json({ name: 'F' }), bobsEnv)).json();
    await authed(`/api/folders/${folder.id}/files`, json({ fileId: bobs }), bobsEnv);
    await setAccessed(env, mine, 61);
    await setAccessed(env, bobs, 61);

    await runScheduled(env);

    expect(await env.HISTORY.get(`meta:${mine}`)).toBeNull();
    expect(await env.HISTORY.get(`meta:${bobs}`)).not.toBeNull();
    expect(JSON.parse(await env.HISTORY.get('user:user_local_dev:notes'))).toEqual([]);
    expect(
      JSON.parse(await env.HISTORY.get('history:user_local_dev')).map((h) => h.id)
    ).not.toContain(mine);
    expect(JSON.parse(await env.HISTORY.get('user:bob:notes'))).toEqual([bobs]);
  });

  it('skips legacy meta entirely when ownerId is missing', async () => {
    const env = devEnv();
    const id = 'legacy-1234';
    await env.MD_FILES.put(`${id}.md`, 'legacy content');
    await env.HISTORY.put(
      `meta:${id}`,
      JSON.stringify({
        filename: 'Legacy.md',
        source: 'upload',
        size: 14,
        created: daysAgo(90),
        lastAccessedAt: daysAgo(61),
      })
    );

    await runScheduled(env);

    const meta = JSON.parse(await env.HISTORY.get(`meta:${id}`));
    expect(meta).not.toBeNull();
    expect(meta.archivedAt).toBeUndefined();
    expect(await env.MD_FILES.get(`${id}.md`)).not.toBeNull();
  });
});
