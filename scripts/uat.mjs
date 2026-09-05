#!/usr/bin/env node
// One-command UAT bring-up (detached). Pick a free port → start `wrangler dev --env uat`
// with the auth stub → wait for /api/auth/check → seed → persist state → print a
// scrapeable ready line → exit. `pnpm uat:stop` tears down.
//
// The Worker serves both the API and the static SPA, so there is a single process.
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UAT_DIR = path.join(ROOT, '.uat');
const STATE = path.join(UAT_DIR, 'state.json');
const STUB_USER = 'user_local_dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
async function pickPort(start) {
  let p = start;
  while (!(await isFree(p))) p++;
  return p;
}
function httpReq(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function waitReady(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpReq(`http://localhost:${port}/api/auth/check`);
      if (r.status === 200 && JSON.parse(r.data).authenticated === true) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`Worker did not come up on port ${port} within ${timeoutMs}ms`);
}

// Refuse to start if a previous run is still live.
if (fs.existsSync(STATE)) {
  const alive = (pid) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    console.warn('Ignoring unreadable .uat/state.json (treating any previous run as stale).');
  }
  if (prev && alive(prev.pid)) {
    console.error('UAT already running (see .uat/state.json). Run `pnpm uat:stop` first.');
    process.exit(1);
  }
}
fs.mkdirSync(UAT_DIR, { recursive: true });

const port = await pickPort(8787);
const log = fs.openSync(path.join(UAT_DIR, 'worker.log'), 'a');
const child = spawn(
  'pnpm',
  [
    'exec',
    'wrangler',
    'dev',
    '--env',
    'uat',
    '--port',
    String(port),
    '--var',
    `AUTH_STUB_USER:${STUB_USER}`,
  ],
  { cwd: ROOT, detached: true, stdio: ['ignore', log, log] }
);
child.unref();
fs.writeFileSync(STATE, JSON.stringify({ pid: child.pid, port }, null, 2));

console.log(`• Waiting for worker on :${port} …`);
try {
  await waitReady(port);
} catch (err) {
  console.error(String(err.message));
  console.error('See .uat/worker.log for details. Run `pnpm uat:stop` to clean up.');
  process.exit(1);
}

console.log('• Seeding scenarios…');
const seed = await httpReq(`http://localhost:${port}/api/dev/seed`, 'POST').catch((e) => ({
  status: 0,
  data: e.message,
}));
if (seed.status !== 200) {
  console.error(`Seed failed: HTTP ${seed.status} — ${seed.data}`);
  console.error('Run `pnpm uat:stop` to clean up.');
  process.exit(1);
}

console.log('');
console.log(`UAT ready: http://localhost:${port}`);
console.log('Seed: short | wide table | code blocks | long | 3 folders | archived | expiring');
console.log('Logs: .uat/worker.log   Stop: pnpm uat:stop');
process.exit(0);
