import { describe, it, expect, beforeEach } from 'vitest';
import { authed, asUser, clearAll, devEnv, json, paste, readJson } from './test-utils/app.js';

const SRC = '# Plan\n\nShip to all customers soon.\nRollback is one flag.\n';
const quoteAnchor = (quote, line) => ({
  quote,
  approx: false,
  prefix: '',
  suffix: '',
  lines: [line, line],
});
const post = (id, body, extra) => authed(`/api/files/${id}/comments`, json(body, extra));

describe('comments', () => {
  let id;
  beforeEach(async () => {
    await clearAll();
    id = await paste(SRC, 'Plan');
  });

  it('starts empty', async () => {
    const res = await authed(`/api/files/${id}/comments`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ round: 1, items: [] });
  });

  it('creates comments with server-assigned ids, rev, author and resolved lines', async () => {
    const res = await post(id, {
      tag: 'fix',
      note: 'Give a date',
      anchor: quoteAnchor('soon', 99),
    });
    expect(res.status).toBe(201);
    const { item } = await res.json();
    expect(item).toMatchObject({
      id: 'c1',
      tag: 'fix',
      note: 'Give a date',
      status: 'open',
      carried: 0,
      rev: 0,
      authorId: 'user_local_dev',
    });
    expect(item.anchor.lines).toEqual([3, 3]);
    const keep = await (
      await post(id, { tag: 'keep', anchor: quoteAnchor('Rollback is one flag.', 4) })
    ).json();
    expect(keep.item.id).toBe('k2');
  });

  it('answers 409 when the quote is not in the current source', async () => {
    const res = await post(id, { tag: 'fix', note: 'x', anchor: quoteAnchor('not there', 3) });
    expect(res.status).toBe(409);
  });

  it('accepts approx and block anchors by line range, rejects out-of-range', async () => {
    const approx = { ...quoteAnchor('ship to all', 3), approx: true };
    expect((await post(id, { tag: 'cut', anchor: approx })).status).toBe(201);
    const block = {
      ...quoteAnchor('', 3),
      lines: [3, 4],
      block: { kind: 'paragraph', label: 'paragraph "Ship to all"' },
    };
    expect((await post(id, { tag: 'q', note: 'Why?', anchor: block })).status).toBe(201);
    expect((await post(id, { tag: 'cut', anchor: { ...approx, lines: [50, 51] } })).status).toBe(
      409
    );
  });

  it('validates the body', async () => {
    expect((await post(id, { tag: 'nope', anchor: quoteAnchor('soon', 3) })).status).toBe(400);
    expect((await post(id, { tag: 'fix', anchor: quoteAnchor('soon', 3) })).status).toBe(400); // fix needs note or replace
    expect((await post(id, { tag: 'fix', note: 'x' })).status).toBe(400); // needs anchor
    expect((await post(id, { tag: 'general' })).status).toBe(400); // needs note
    expect((await post(id, { tag: 'general', note: 'Tone' })).status).toBe(201);
    expect((await post(id, { tag: 'general', note: 'Again' })).status).toBe(400); // one per note
  });

  it('patches note, tag and status; never reuses ids after delete', async () => {
    await post(id, { tag: 'fix', note: 'a', anchor: quoteAnchor('soon', 3) });
    const patched = await authed(
      `/api/files/${id}/comments/c1`,
      json({ note: 'b', tag: 'q', status: 'addressed' }, { method: 'PATCH' })
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()).item).toMatchObject({ note: 'b', tag: 'q', status: 'addressed' });
    const badTag = await authed(
      `/api/files/${id}/comments/c1`,
      json({ tag: 'keep' }, { method: 'PATCH' })
    );
    expect(badTag.status).toBe(400); // keep <-> non-keep would change the id prefix
    expect((await authed(`/api/files/${id}/comments/c1`, { method: 'DELETE' })).status).toBe(200);
    expect((await authed(`/api/files/${id}/comments/c1`, { method: 'DELETE' })).status).toBe(404);
    const next = await (await post(id, { tag: 'cut', anchor: quoteAnchor('soon', 3) })).json();
    expect(next.item.id).toBe('c2');
  });

  it('is owner-only: another user gets 404 on every route', async () => {
    await post(id, { tag: 'cut', anchor: quoteAnchor('soon', 3) });
    const other = { headers: asUser('someone_else') };
    expect((await authed(`/api/files/${id}/comments`, other)).status).toBe(404);
    expect((await post(id, { tag: 'cut', anchor: quoteAnchor('soon', 3) }, other)).status).toBe(
      404
    );
    expect(
      (
        await authed(
          `/api/files/${id}/comments/c1`,
          json({ note: 'x' }, { method: 'PATCH', ...other })
        )
      ).status
    ).toBe(404);
    expect(
      (await authed(`/api/files/${id}/comments/c1`, { method: 'DELETE', ...other })).status
    ).toBe(404);
  });

  it('enforces the 500-item cap', async () => {
    const env = devEnv();
    const items = Array.from({ length: 500 }, (_, i) => ({ id: `c${i + 1}`, tag: 'cut' }));
    await env.HISTORY.put(`comments:${id}`, JSON.stringify({ nextId: 501, round: 1, items }));
    expect((await post(id, { tag: 'cut', anchor: quoteAnchor('soon', 3) })).status).toBe(400);
  });

  it('deleting the note removes its comments', async () => {
    await post(id, { tag: 'cut', anchor: quoteAnchor('soon', 3) });
    const env = devEnv();
    expect(await readJson(env, `comments:${id}`)).not.toBeNull();
    await authed(`/api/files/${id}`, { method: 'DELETE' });
    expect(await readJson(env, `comments:${id}`)).toBeNull();
  });
});
