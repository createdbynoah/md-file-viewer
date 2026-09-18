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
  makeEnv,
} from './test-utils/app.js';
import { uuidToShortId } from './og.js';

const alice = () => devEnv({ AUTH_STUB_USER: 'alice' });
const SECRET_BODY = '# Heading\n\nThe launch code is **swordfish** and more text.';
const SECRET_NAME = 'Quarterly-Plans';

async function share(env, id) {
  await authed(
    `/api/files/${id}/visibility`,
    json({ visibility: 'link' }, { method: 'PATCH' }),
    env
  );
}

/** The untouched index, as served for an id that matches no note. */
async function genericHtml() {
  return (await call('/123e4567-e89b-12d3-a456-426614174000')).text();
}

function expectGeneric(html) {
  expect(html).not.toContain(SECRET_NAME);
  expect(html).not.toContain('swordfish');
  expect(html).not.toContain('Heading');
}

describe('per-note Open Graph tags', () => {
  beforeEach(() => clearAll());

  it('link note: anonymous crawler gets name, excerpt and canonical short url', async () => {
    const env = alice();
    const id = await paste(SECRET_BODY, SECRET_NAME, env);
    await share(env, id);

    const html = await (await call(`/${uuidToShortId(id)}`)).text();
    expect(html).toContain(`<title>${SECRET_NAME}</title>`);
    expect(html).toContain(`<meta property="og:title" content="${SECRET_NAME}"`);
    expect(html).toContain(`<meta name="twitter:title" content="${SECRET_NAME}"`);
    const desc = 'Heading The launch code is swordfish and more text.';
    expect(html).toContain(`<meta property="og:description" content="${desc}"`);
    expect(html).toContain(`<meta name="twitter:description" content="${desc}"`);
    expect(html).toContain(`<meta name="description" content="${desc}"`);
    expect(html).toContain(`<meta property="og:url" content="http://test/${uuidToShortId(id)}"`);
    expect(html).toContain('og-image.png');
  });

  it('link note via legacy uuid path points og:url at the short form', async () => {
    const env = alice();
    const id = await paste(SECRET_BODY, SECRET_NAME, env);
    await share(env, id);
    const html = await (await call(`/${id}`)).text();
    expect(html).toContain(`content="http://test/${uuidToShortId(id)}"`);
  });

  it('private note: anonymous response is byte-identical to a missing note', async () => {
    const id = await paste(SECRET_BODY, SECRET_NAME, alice());
    const html = await (await call(`/${uuidToShortId(id)}`)).text();
    expectGeneric(html);
    expect(html).toBe(await genericHtml());
  });

  it('private note: even the owner gets generic tags (output never depends on auth)', async () => {
    const env = alice();
    const id = await paste(SECRET_BODY, SECRET_NAME, env);
    const html = await (await authed(`/${uuidToShortId(id)}`, {}, env)).text();
    expectGeneric(html);
    expect(html).toBe(await genericHtml());
  });

  it('link note flipped back to private returns to generic', async () => {
    const env = alice();
    const id = await paste(SECRET_BODY, SECRET_NAME, env);
    await share(env, id);
    await authed(
      `/api/files/${id}/visibility`,
      json({ visibility: 'private' }, { method: 'PATCH' }),
      env
    );
    expectGeneric(await (await call(`/${uuidToShortId(id)}`)).text());
  });

  it('legacy note without ownerId or visibility is generic', async () => {
    const env = makeEnv();
    const id = '123e4567-e89b-12d3-a456-426614174abc';
    await env.HISTORY.put(`meta:${id}`, JSON.stringify({ id, filename: SECRET_NAME }));
    await env.MD_FILES.put(`${id}.md`, SECRET_BODY);
    expectGeneric(await (await call(`/${id}`, { headers: asUser('bob') }, alice())).text());
  });

  it('archived link note is generic', async () => {
    const env = alice();
    const id = await paste(SECRET_BODY, SECRET_NAME, env);
    await share(env, id);
    const meta = await readJson(env, `meta:${id}`);
    meta.archivedAt = new Date().toISOString();
    await env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));
    expectGeneric(await (await call(`/${uuidToShortId(id)}`)).text());
  });

  it('escapes a hostile note name and content', async () => {
    const env = alice();
    const id = await paste('"><script>alert(1)</script> body', '"><script>x</script>', env);
    await share(env, id);
    const html = await (await call(`/${uuidToShortId(id)}`)).text();
    // No attribute breakout (quote escaped; '<' is inert inside a quoted value)
    // and no live element in <title>.
    expect(html).not.toContain('""><script>');
    expect(html).not.toContain('content=""');
    expect(html).toContain('<title>"&gt;&lt;script&gt;x&lt;/script&gt;</title>');
    expect(html).toContain('<meta property="og:title" content="&quot;><script>x</script>" />');
  });

  it('link note whose R2 object is missing keeps the generic description', async () => {
    const env = alice();
    const id = await paste(SECRET_BODY, SECRET_NAME, env);
    await share(env, id);
    await env.MD_FILES.delete(`${id}.md`);
    const html = await (await call(`/${uuidToShortId(id)}`)).text();
    expect(html).toContain(`<meta property="og:title" content="${SECRET_NAME}"`);
    expect(html).toContain('<meta property="og:description" content="generic description"');
  });
});
