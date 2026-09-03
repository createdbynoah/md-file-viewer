// Shared helpers for workers-pool integration tests.
// The Hono app is driven directly via worker.fetch(req, env, ctx) so tests
// control the full env (including a stubbed ASSETS fetcher).
import { env as baseEnv, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker.js';

export const assetsStub = {
  fetch: async (req) =>
    new Response(`<html>index for ${new URL(req.url).pathname}</html>`, {
      headers: { 'content-type': 'text/html' },
    }),
};

export function makeEnv(overrides = {}) {
  return { ...baseEnv, ASSETS: assetsStub, ...overrides };
}

export async function call(path, init = {}, env = makeEnv()) {
  const ctx = createExecutionContext();
  const req = new Request(`http://test${path}`, init);
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function login(env = makeEnv(), password = 'test-password') {
  const res = await call(
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    },
    env
  );
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  return { res, cookie };
}

export function json(body, extra = {}) {
  return {
    method: 'POST',
    ...extra,
    headers: { 'content-type': 'application/json', ...(extra.headers || {}) },
    body: JSON.stringify(body),
  };
}

export async function authed(path, init = {}, env = makeEnv()) {
  const { cookie } = await login(env);
  return call(path, { ...init, headers: { ...(init.headers || {}), cookie } }, env);
}

/** Creates a note via /api/paste and returns its id. */
export async function paste(content, title, env = makeEnv()) {
  const res = await authed('/api/paste', json({ content, title }), env);
  const body = await res.json();
  return body.id;
}

export async function runScheduled(env = makeEnv()) {
  const ctx = createExecutionContext();
  await worker.scheduled({ cron: '0 3 * * *', scheduledTime: Date.now() }, env, ctx);
  await waitOnExecutionContext(ctx);
}

export async function clearAll(env = makeEnv()) {
  const list = await env.HISTORY.list();
  await Promise.all(list.keys.map((k) => env.HISTORY.delete(k.name)));
  const objs = await env.MD_FILES.list();
  await Promise.all(objs.objects.map((o) => env.MD_FILES.delete(o.key)));
}
