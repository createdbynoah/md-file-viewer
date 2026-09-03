#!/usr/bin/env node
// Tear down a `pnpm uat` session: kill the wrangler process group by pidfile.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, '.uat', 'state.json');

if (!fs.existsSync(STATE)) {
  console.log('Nothing to stop (no .uat/state.json).');
  process.exit(0);
}
const { pid } = JSON.parse(fs.readFileSync(STATE, 'utf8'));

// Detached child is a process-group leader; negative pid kills wrangler + workerd.
let stopped = false;
for (const target of [-pid, pid]) {
  try {
    process.kill(target, 'SIGTERM');
    stopped = true;
    break;
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}
console.log(stopped ? `Stopped worker (pid ${pid}).` : `Worker (pid ${pid}) was not running.`);
fs.rmSync(STATE, { force: true });
console.log('UAT stopped.');
