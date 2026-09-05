#!/usr/bin/env node
// One-shot production migration: stamp every legacy note to OWNER_SUB and move
// the global history/folders keys to per-user keys. Idempotent.
//
//   pnpm migrate:owner <owner-sub>            # against the remote HISTORY namespace
//   pnpm migrate:owner <owner-sub> --local    # against the local wrangler dev store
//
// Find your sub: sign in once, then `wrangler kv key list --binding HISTORY --remote --prefix user:`.
import { execFileSync } from 'node:child_process';
import { migrateToOwner } from '../src/migrate.js';

const [ownerId, ...flags] = process.argv.slice(2);
if (!ownerId || ownerId.startsWith('-')) {
  console.error('usage: migrate-owner.mjs <owner-sub> [--local]');
  process.exit(1);
}
const target = flags.includes('--local') ? '--local' : '--remote';

/**
 * Runs `wrangler kv key <args> --binding HISTORY <target>`.
 * `stdout` is captured; `stderr` is piped so we can inspect it (wrangler's
 * banner and its "Value not found" notice both land there) and re-emitted.
 */
function wrangler(args, input) {
  const res = execFileSync(
    'pnpm',
    ['exec', 'wrangler', 'kv', 'key', ...args, '--binding', 'HISTORY', target],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  return res;
}

const kv = {
  async list({ prefix }) {
    // `wrangler kv key list` paginates internally and prints the full JSON
    // array of { name, ... } on stdout (its banner goes to stderr).
    const out = wrangler(['list', '--prefix', prefix]);
    return { keys: JSON.parse(out), list_complete: true };
  },
  async get(key) {
    let out;
    try {
      out = wrangler(['get', key, '--text']);
    } catch {
      // A hard failure (auth, network) — treat as absent rather than crashing
      // mid-run; the migration is idempotent, so a re-run picks it back up.
      return null;
    }
    const value = out.replace(/\n$/, '');
    // wrangler 4 exits 0 for a missing key and prints this sentinel instead.
    if (value === 'Value not found') return null;
    return value;
  },
  async put(key, value) {
    // `--path /dev/stdin` + execFileSync's `input` streams the value in,
    // avoiding argv length limits and shell quoting. Verified on macOS.
    wrangler(['put', key, '--path', '/dev/stdin'], value);
  },
  async delete(key) {
    // wrangler 4's `kv key delete` has no --force; with a non-TTY stdin it
    // does not prompt.
    wrangler(['delete', key]);
  },
};

const result = await migrateToOwner(kv, ownerId, {
  log: (msg, data) => console.log(msg, data ? JSON.stringify(data) : ''),
});
console.log('done', JSON.stringify(result));
