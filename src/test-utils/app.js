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

/** Env with the UAT stub on: every request is authenticated as AUTH_STUB_USER. */
export function devEnv(overrides = {}) {
  return makeEnv({ ENVIRONMENT: 'uat', AUTH_STUB_USER: 'user_local_dev', ...overrides });
}

/** Header that switches identity under the dev stub (ignored outside isDevEnv). */
export function asUser(id) {
  return { 'x-dev-user': id };
}

export function json(body, extra = {}) {
  return {
    method: 'POST',
    ...extra,
    headers: { 'content-type': 'application/json', ...(extra.headers || {}) },
    body: JSON.stringify(body),
  };
}

/** Sends a request as an authenticated user via the dev stub. */
export async function authed(path, init = {}, env = devEnv()) {
  return call(path, init, env);
}

/** Creates a note via /api/paste and returns its id. */
export async function paste(content, title, env = devEnv()) {
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
