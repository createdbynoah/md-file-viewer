// Deterministic UAT seed. Only reachable through /api/dev/seed, which is
// mounted only when isDevEnv() is true (see worker.js). Replaces, never appends.

const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

// Fixed UUIDs so deep links are stable across re-seeds.
export const SEED_IDS = {
  short: '11111111-1111-4111-8111-111111111111',
  wide: '22222222-2222-4222-8222-222222222222',
  code: '33333333-3333-4333-8333-333333333333',
  long: '44444444-4444-4444-8444-444444444444',
  folderA1: '55555555-5555-4555-8555-555555555555',
  folderA2: '66666666-6666-4666-8666-666666666666',
  folderB1: '77777777-7777-4777-8777-777777777777',
  archived: '88888888-8888-4888-8888-888888888888',
  expiring: '99999999-9999-4999-8999-999999999999',
  otherPrivate: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherLink: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

const OWNER = 'user_local_dev';
const OTHER = 'other_user';

const WIDE_TABLE = [
  '# Wide table',
  '',
  '| ' + Array.from({ length: 14 }, (_, i) => `Column ${i + 1}`).join(' | ') + ' |',
  '|' + ' --- |'.repeat(14),
  ...Array.from(
    { length: 12 },
    (_, r) => '| ' + Array.from({ length: 14 }, (_, c) => `r${r + 1}c${c + 1}`).join(' | ') + ' |'
  ),
  '',
  'Should scroll horizontally inside `.table-wrapper`, not the page.',
].join('\n');

const CODE = `# Code blocks

\`\`\`js
export async function handler(req) {
  const { id } = await req.json();
  return new Response(JSON.stringify({ id }), { status: 200 });
}
\`\`\`

\`\`\`python
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
\`\`\`

\`\`\`bash
pnpm uat && open http://localhost:8787
\`\`\`

\`\`\`
plain fenced block with no language
\`\`\`

Inline \`code\` too.
`;

const LONG = ['# Long note', '']
  .concat(
    Array.from(
      { length: 60 },
      (_, i) =>
        `## Section ${i + 1}\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Paragraph ${i + 1} of a long note used to verify the scroll container, sticky topbar, and back-to-top behaviour.\n`
    )
  )
  .join('\n');

/**
 * @param {string} id
 * @param {string} filename
 * @param {string} content
 * @param {{createdDays?: number, accessedDays?: number, source?: string, folderId?: string, archivedAt?: string, ownerId?: string, visibility?: string}} [opts]
 */
function note(
  id,
  filename,
  content,
  {
    createdDays = 0,
    accessedDays = createdDays,
    source = 'paste',
    folderId,
    archivedAt,
    ownerId = OWNER,
    visibility = 'private',
  } = {}
) {
  const meta = {
    filename,
    source,
    size: content.length,
    created: ago(createdDays),
    lastAccessedAt: ago(accessedDays),
    ownerId,
    visibility,
    editors: [],
    currentRev: 0,
  };
  if (folderId) meta.folderId = folderId;
  if (archivedAt) meta.archivedAt = archivedAt;
  return { id, content, meta };
}

export async function seedScenarios(env) {
  // Wipe
  const keys = await env.HISTORY.list();
  await Promise.all(keys.keys.map((k) => env.HISTORY.delete(k.name)));
  const objs = await env.MD_FILES.list();
  await Promise.all(objs.objects.map((o) => env.MD_FILES.delete(o.key)));

  const folders = [
    {
      id: 'f-seedaaaa',
      name: 'Project Alpha',
      fileIds: [SEED_IDS.folderA1, SEED_IDS.folderA2],
      created: ago(10),
    },
    { id: 'f-seedbbbb', name: 'Recipes', fileIds: [SEED_IDS.folderB1], created: ago(5) },
    { id: 'f-seedcccc', name: 'Empty folder', fileIds: [], created: ago(1) },
  ];

  const notes = [
    note(SEED_IDS.short, 'Short note.md', '# Hello\n\nA very short note.\n', { source: 'upload' }),
    note(SEED_IDS.wide, 'Wide table', WIDE_TABLE, { createdDays: 1, visibility: 'link' }),
    note(SEED_IDS.code, 'Code blocks', CODE, { createdDays: 2 }),
    note(SEED_IDS.long, 'Long note', LONG, { createdDays: 8 }),
    note(SEED_IDS.folderA1, 'Alpha spec.md', '# Alpha spec\n\n- goal\n- scope\n', {
      createdDays: 10,
      source: 'upload',
      folderId: 'f-seedaaaa',
    }),
    note(SEED_IDS.folderA2, 'Alpha notes', '# Alpha notes\n\nMeeting notes.\n', {
      createdDays: 9,
      folderId: 'f-seedaaaa',
    }),
    note(SEED_IDS.folderB1, 'Pancakes', '# Pancakes\n\n1. flour\n2. eggs\n', {
      createdDays: 45,
      folderId: 'f-seedbbbb',
    }),
    // 31 days idle -> archived by retention (hidden from sidebar, still fetchable)
    note(SEED_IDS.archived, 'Archived note', '# Archived\n\nShould be hidden.\n', {
      createdDays: 40,
      accessedDays: 31,
      archivedAt: ago(1),
    }),
    // 59 days idle -> deleted on the next retention run
    note(SEED_IDS.expiring, 'Expiring note', '# Expiring\n\nOne day from deletion.\n', {
      createdDays: 80,
      accessedDays: 59,
      archivedAt: ago(29),
    }),
    note(SEED_IDS.otherPrivate, 'Other private', '# Other\n\nPrivate to other_user.\n', {
      ownerId: OTHER,
    }),
    note(SEED_IDS.otherLink, 'Other shared', '# Other\n\nShared by link.\n', {
      ownerId: OTHER,
      visibility: 'link',
    }),
  ];

  for (const n of notes) {
    await env.MD_FILES.put(`${n.id}.md`, n.content);
    await env.HISTORY.put(`meta:${n.id}`, JSON.stringify(n.meta));
  }
  await env.HISTORY.put(`folders:${OWNER}`, JSON.stringify(folders));

  const notesByOwner = (ownerId) =>
    notes
      .filter((n) => n.meta.ownerId === ownerId)
      .sort((a, b) => new Date(b.meta.created).getTime() - new Date(a.meta.created).getTime())
      .map((n) => n.id);
  await env.HISTORY.put(`user:${OWNER}:notes`, JSON.stringify(notesByOwner(OWNER)));
  await env.HISTORY.put(`user:${OTHER}:notes`, JSON.stringify(notesByOwner(OTHER)));

  // History: today / yesterday / this week / older buckets, plus the archived one.
  const history = [
    { id: SEED_IDS.short, filename: 'Short note.md', source: 'upload', viewedAt: ago(0) },
    { id: SEED_IDS.wide, filename: 'Wide table', source: 'paste', viewedAt: ago(1) },
    { id: SEED_IDS.code, filename: 'Code blocks', source: 'paste', viewedAt: ago(2) },
    { id: SEED_IDS.long, filename: 'Long note', source: 'paste', viewedAt: ago(4) },
    { id: SEED_IDS.folderA1, filename: 'Alpha spec.md', source: 'upload', viewedAt: ago(10) },
    { id: SEED_IDS.archived, filename: 'Archived note', source: 'paste', viewedAt: ago(31) },
  ];
  await env.HISTORY.put(`history:${OWNER}`, JSON.stringify(history));

  return { notes: notes.length, folders: folders.length, history: history.length };
}
