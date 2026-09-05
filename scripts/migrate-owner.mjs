#!/usr/bin/env node
// One-shot production migration: stamp every legacy note to OWNER_SUB and move
// the global history/folders keys to per-user keys. Idempotent.
//
//   pnpm migrate:owner <owner-sub>              # against the remote HISTORY namespace
//   pnpm migrate:owner <owner-sub> --local      # against the local wrangler dev store
//   pnpm migrate:owner <owner-sub> --dry-run    # read everything, write nothing
//
// Find your sub: sign in once, then `wrangler kv key list --binding HISTORY --remote --prefix user:`.
//
// Before the first write of a real run the CLI dumps every key it could touch
// (`history`, `folders`, all `meta:*`) to .migrate-backup/<timestamp>.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrateToOwner } from '../src/migrate.js';

const [ownerId, ...flags] = process.argv.slice(2);
if (!ownerId || ownerId.startsWith('-')) {
  console.error('usage: migrate-owner.mjs <owner-sub> [--local] [--dry-run]');
  process.exit(1);
}
const target = flags.includes('--local') ? '--local' : '--remote';
const dryRun = flags.includes('--dry-run');

/**
 * Runs `wrangler kv key <args> --binding HISTORY <target>`.
 * `stdout` is captured; `stderr` is piped so we can inspect it (wrangler's
 * banner and its "Value not found" notice both land there).
 */
function wrangler(args, input) {
  return execFileSync(
    'pnpm',
    ['exec', 'wrangler', 'kv', 'key', ...args, '--binding', 'HISTORY', target],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

/** The raw adapter. `get` returns null ONLY for a genuine miss — see below. */
const raw = {
  async list({ prefix }) {
    // `wrangler kv key list` prints the full JSON array of { name, ... } on
    // stdout (its banner goes to stderr). Against --remote it paginates
    // internally, so one call is the whole namespace; --local returns a single
    // page, so a local rehearsal is capped at 1000 keys.
    const out = wrangler(['list', '--prefix', prefix]);
    return { keys: JSON.parse(out), list_complete: true };
  },
  async get(key) {
    let out;
    try {
      out = wrangler(['get', key, '--text']);
    } catch (err) {
      // Remote wrangler exits non-zero for a missing key. Only a "not found"
      // shaped failure means absent; anything else (auth, 5xx, network) must
      // propagate — swallowing it would make the module overwrite a per-user
      // key with partial data and then delete the legacy source.
      const detail = `${err?.stdout ?? ''}\n${err?.stderr ?? ''}`;
      if (/not found|10009|404/i.test(detail)) return null;
      throw err;
    }
    const value = out.replace(/\n$/, '');
    // Local wrangler 4 exits 0 for a missing key and prints this sentinel.
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

/**
 * Dumps every key the migration could touch, as raw strings, so a bad run can
 * be restored by hand. Called lazily, once, immediately before the first write.
 */
async function backup() {
  const dump = { history: await raw.get('history'), folders: await raw.get('folders'), meta: {} };
  for (const { name } of (await raw.list({ prefix: 'meta:' })).keys) {
    dump.meta[name] = await raw.get(name);
  }
  const dir = '.migrate-backup';
  mkdirSync(dir, { recursive: true });
  // Colons are legal on APFS/ext4 but confuse Finder and Windows, so the ISO
  // timestamp is written with `-` separators.
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(dump, null, 2));
  console.log(`backup written: ${file}`);
}

let backedUp = false;
async function beforeWrite() {
  if (backedUp) return;
  backedUp = true;
  await backup();
}

const kv = {
  list: raw.list,
  get: raw.get,
  async put(key, value) {
    if (dryRun) {
      console.log(`[dry-run] put ${key} (${Buffer.byteLength(value)} bytes)`);
      return;
    }
    await beforeWrite();
    await raw.put(key, value);
  },
  async delete(key) {
    if (dryRun) {
      console.log(`[dry-run] delete ${key}`);
      return;
    }
    await beforeWrite();
    await raw.delete(key);
  },
};

if (dryRun) console.log('dry run: no writes will be made');
const result = await migrateToOwner(kv, ownerId, {
  log: (msg, data) => console.log(msg, data ? JSON.stringify(data) : ''),
});
console.log('done', JSON.stringify(result));
