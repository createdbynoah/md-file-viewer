import { describe, it, expect, beforeEach } from 'vitest';
import { authed, asUser, call, clearAll, devEnv, json, paste, readJson } from './test-utils/app.js';

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
    expect(item.anchor.prefix).toBe('# Plan\n\nShip to all customers ');
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

  it('rejects a whitespace-only quote', async () => {
    const res = await post(id, { tag: 'cut', anchor: quoteAnchor('   ', 3) });
    expect(res.status).toBe(400);
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

  it('rejects a JSON body that is not an object', async () => {
    const nullBody = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    };
    expect((await authed(`/api/files/${id}/comments`, nullBody)).status).toBe(400);
    await post(id, { tag: 'fix', note: 'a', anchor: quoteAnchor('soon', 3) });
    const patchNull = await authed(`/api/files/${id}/comments/c1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    });
    expect(patchNull.status).toBe(400);
  });

  it('will not let a PATCH empty a note that requires one', async () => {
    await post(id, { tag: 'fix', note: 'a', replace: 'b', anchor: quoteAnchor('soon', 3) });
    const patch = (body) => authed(`/api/files/${id}/comments/c1`, json(body, { method: 'PATCH' }));
    expect((await patch({ note: '', replace: '' })).status).toBe(400);
    // the rejected PATCH leaves the stored item untouched
    const still = await (await authed(`/api/files/${id}/comments`)).json();
    expect(still.items[0]).toMatchObject({ note: 'a', replace: 'b' });
    // dropping only one of the two is fine while the other remains
    expect((await patch({ replace: '' })).status).toBe(200);
    expect((await patch({ note: '' })).status).toBe(400);
    // a cut needs neither
    expect((await patch({ tag: 'cut', note: '' })).status).toBe(200);
  });

  it('requires authentication: an anonymous request gets 401', async () => {
    expect((await call(`/api/files/${id}/comments`)).status).toBe(401);
    expect(
      (
        await call(
          `/api/files/${id}/comments`,
          json({ tag: 'cut', anchor: quoteAnchor('soon', 3) })
        )
      ).status
    ).toBe(401);
  });

  it('stays owner-only on a link-visible note', async () => {
    await authed(`/api/files/${id}/visibility`, json({ visibility: 'link' }, { method: 'PATCH' }));
    await post(id, { tag: 'cut', anchor: quoteAnchor('soon', 3) });
    const other = { headers: asUser('someone_else') };
    // the other user can read the note itself...
    expect((await authed(`/api/files/${id}`, other)).status).toBe(200);
    // ...but not its comments
    expect((await authed(`/api/files/${id}/comments`, other)).status).toBe(404);
    expect((await post(id, { tag: 'cut', anchor: quoteAnchor('soon', 3) }, other)).status).toBe(
      404
    );
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

  const put = (noteId, content) =>
    authed(`/api/files/${noteId}`, json({ content }, { method: 'PUT' }));
  const list = async (noteId) => (await authed(`/api/files/${noteId}/comments`)).json();

  it('triages comments when a revision lands', async () => {
    await post(id, { tag: 'fix', note: 'Give a date', anchor: quoteAnchor('soon', 3) });
    await post(id, { tag: 'keep', anchor: quoteAnchor('Rollback is one flag.', 4) });
    await post(id, {
      tag: 'fix',
      note: 'Which customers?',
      anchor: quoteAnchor('all customers', 3),
    });
    const res = await put(id, SRC.replace('soon', 'on 1 March').replace('one flag', 'two flags'));
    expect(res.status).toBe(200);
    expect((await res.json()).triage).toEqual({
      rev: 1,
      round: 2,
      addressed: 1,
      carried: 1,
      violated: 1,
      restored: 0,
    });
    const after = await list(id);
    expect(after.round).toBe(2);
    expect(after.lastTriage.rev).toBe(1);
    const [c1, k2, c3] = after.items;
    // The neighbouring sentence changed too, so c1's 32-char suffix did not
    // survive and no replacement text could be pinned down.
    expect(c1).toMatchObject({ status: 'addressed', resolvedRev: 1, rev: 1 });
    expect(c1.replacedBy).toBeUndefined();
    expect(k2).toMatchObject({ status: 'violated', rev: 1 });
    expect(c3).toMatchObject({ status: 'open', carried: 1, rev: 1 });
  });

  it('a PUT with no comments reports no triage and writes no comments key', async () => {
    const res = await put(id, SRC + '\nmore\n');
    expect((await res.json()).triage).toBeNull();
    expect(await readJson(devEnv(), `comments:${id}`)).toBeNull();
  });

  it('a corrupt comments value never fails the save', async () => {
    const env = devEnv();
    await env.HISTORY.put(
      `comments:${id}`,
      JSON.stringify({ nextId: 2, round: 1, items: [{ id: 'c1', anchor: 7 }] })
    );
    const res = await put(id, SRC + '\nmore\n');
    expect(res.status).toBe(200);
    expect((await res.json()).triage).toBeNull();
    expect((await readJson(env, `comments:${id}`)).items[0].anchor).toBe(7); // untouched
  });

  it('reopening an addressed comment re-anchors it to what replaced it', async () => {
    await post(id, { tag: 'fix', note: 'Give a date', anchor: quoteAnchor('soon', 3) });
    await put(id, SRC.replace('soon', 'on 1 March'));
    const res = await authed(
      `/api/files/${id}/comments/c1`,
      json({ status: 'open' }, { method: 'PATCH' })
    );
    const { item } = await res.json();
    expect(item.status).toBe('open');
    expect(item.anchor.quote).toBe('on 1 March');
    expect(item.replacedBy).toBeUndefined();
    expect(item.resolvedRev).toBeUndefined();
    expect(item.rev).toBe(1);
  });

  it('a violated keep cannot be re-statused through PATCH, only deleted', async () => {
    await post(id, { tag: 'keep', anchor: quoteAnchor('Rollback is one flag.', 4) });
    await put(id, SRC.replace('one flag', 'two flags'));
    const patched = await authed(
      `/api/files/${id}/comments/k1`,
      json({ status: 'open' }, { method: 'PATCH' })
    );
    expect(patched.status).toBe(400);
    expect((await authed(`/api/files/${id}/comments/k1`, { method: 'DELETE' })).status).toBe(200);
  });
});
