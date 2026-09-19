# Markup Comments — Phase A1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The note owner can, on desktop (≥1024px), select text or a block in a rendered note, attach a tagged comment, see comments as highlights plus a margin rail, and copy a token-efficient feedback block for an agent.

**Architecture:** Anchors are quote selectors resolved against the raw markdown source (pure `anchor.js`, shared by client and worker). Comments live in one KV value per note (`comments:{uuid}`) behind owner-only CRUD routes in `src/worker.js`. The feedback text comes from a pure `feedback-format.js`. All DOM behavior lives in a new `comments-ui.js`; `app.js` gains wiring only.

**Tech Stack:** Hono on Cloudflare Workers, KV, vanilla ES modules (no build step), markdown-it 14 (CDN in the browser, devDependency for tests), CSS Custom Highlight API, vitest 3 (unit + workers-pool integration).

**Spec:** `docs/plans/2026-09-18-markup-comments-design.md` — read it first. This plan implements its phase **A1** only. Deferred to later plans: tablet/mobile UI (A2); triage, round banner, mini-diff, violated keeps, the Copy-feedback ▾ menu and CriticMarkup export (A3); tokens, `/feedback` endpoint, MCP (B).

## Global Constraints

- Owner-only: every comment route answers **404** (never 403) when the note is missing or `meta.ownerId !== user.id`.
- Storage key is exactly `comments:{uuid}`; one JSON value `{ nextId, round, items }`; cap **500** items (POST → 400 beyond it). `deleteNoteObjects()` must delete it.
- Ids: `k<n>` for `keep`, `c<n>` for everything else, both drawn from the single `nextId` counter; never reused.
- Tags: `fix`, `cut`, `q`, `keep`, `general`. Statuses: `open`, `addressed`, `violated` (A1 never sets `violated`).
- Anchor context length: **32** chars of prefix and suffix. Quote elision threshold: **12** words → first 5 … last 5.
- Line numbers are **1-based inclusive** everywhere (`data-line`, `anchor.lines`, the `L` in the export).
- The document source is never modified by commenting.
- No build step: `public/js/*.js` are plain ES modules. The worker imports pure modules from `../public/js/`; they are then type-checked transitively by `pnpm typecheck`, so keep JSDoc accurate.
- Below 1024px the Review button is hidden in A1 (CSS). Do not build mobile UI.
- Keep `background` off sticky/fixed elements at the top edge (iOS 26 rule in CLAUDE.md). Nothing in A1 adds one.
- Commit messages: conventional commits, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never deploy.
- Before each commit: `pnpm lint && pnpm typecheck && pnpm test`.

## File Structure

| File                                | Status | Responsibility                                                          |
| ----------------------------------- | ------ | ----------------------------------------------------------------------- |
| `public/js/anchor.js`               | new    | Pure: line math, capture an anchor from selected text, locate an anchor |
| `public/js/anchor.test.js`          | new    | Unit tests                                                              |
| `public/js/feedback-format.js`      | new    | Pure: `formatFeedback()`                                                |
| `public/js/feedback-format.test.js` | new    | Unit tests                                                              |
| `public/js/source-lines.js`         | new    | markdown-it plugin stamping `data-line` on block tokens                 |
| `public/js/source-lines.test.js`    | new    | Unit tests (uses markdown-it devDependency)                             |
| `public/js/comments-ui.js`          | new    | DOM: review mode, selection popover, gutter `+`, highlights, rail, copy |
| `src/worker.js`                     | modify | Comment CRUD routes; `deleteNoteObjects` cleanup                        |
| `src/comments.integration.test.js`  | new    | Route tests                                                             |
| `src/seed.js`                       | modify | One seeded note with comments                                           |
| `public/index.html`                 | modify | Review + Copy feedback buttons, rail container                          |
| `public/css/style.css`              | modify | Highlights, rail, popover, gutter button                                |
| `public/js/app.js`                  | modify | Wiring only                                                             |
| `CLAUDE.md`                         | modify | Routes table, storage bindings, key patterns                            |

---

### Task 1: `anchor.js` — capture and locate

**Files:**

- Create: `public/js/anchor.js`
- Test: `public/js/anchor.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces (all named exports):
  - `CONTEXT_LEN: 32`
  - `lineAt(source: string, offset: number): number` — 1-based line containing `offset`
  - `sliceLines(source: string, lines: [number, number]): { text: string, offset: number }`
  - `wsRegex(quote: string): RegExp` — global regex matching `quote` with any whitespace run ≈ `\s+`
  - `findAll(source: string, quote: string): number[]` — start offsets of exact occurrences
  - `captureAnchor(source, lines, selectedText): Anchor`
  - `blockAnchor(lines, kind, label): Anchor`
  - `locate(source, anchor): { start: number|null, end: number|null, lines: [number, number] } | null`
  - `nthInLines(source, lines, start, quote): number` — 0-based occurrence index of the hit at `start` within the line slice
  - `Anchor = { quote: string, approx: boolean, prefix: string, suffix: string, lines: [number, number], block?: { kind: string, label: string } }`

- [ ] **Step 1: Write the failing tests**

```js
// public/js/anchor.test.js
import { describe, it, expect } from 'vitest';
import {
  lineAt,
  sliceLines,
  findAll,
  captureAnchor,
  blockAnchor,
  locate,
  nthInLines,
} from './anchor.js';

const SRC = [
  '# Rollout plan', // 1
  '', // 2
  'We will ship to all customers in a single release after the beta ends.', // 3
  'Rollback is a **one-line** flag flip.', // 4
  '', // 5
  'The beta is small. The beta is closed.', // 6
].join('\n');

describe('line math', () => {
  it('lineAt is 1-based', () => {
    expect(lineAt(SRC, 0)).toBe(1);
    expect(lineAt(SRC, SRC.indexOf('We will'))).toBe(3);
  });
  it('sliceLines returns inclusive text and its offset', () => {
    const s = sliceLines(SRC, [3, 4]);
    expect(s.text.startsWith('We will')).toBe(true);
    expect(s.text.endsWith('flag flip.')).toBe(true);
    expect(s.offset).toBe(SRC.indexOf('We will'));
  });
});

describe('captureAnchor', () => {
  it('captures an exact source quote with context', () => {
    const a = captureAnchor(SRC, [3, 3], 'all customers in a single release');
    expect(a.approx).toBe(false);
    expect(a.quote).toBe('all customers in a single release');
    expect(a.lines).toEqual([3, 3]);
    expect(a.prefix.endsWith('ship to ')).toBe(true);
    expect(a.suffix.startsWith(' after the beta')).toBe(true);
    expect(a.prefix.length).toBeLessThanOrEqual(32);
  });
  it('matches across a soft line break and stores the real source substring', () => {
    const a = captureAnchor(SRC, [3, 4], 'beta ends. Rollback is');
    expect(a.approx).toBe(false);
    expect(a.quote).toBe('beta ends.\nRollback is');
    expect(a.lines).toEqual([3, 4]);
  });
  it('falls back to approx when the selection crosses inline formatting', () => {
    const a = captureAnchor(SRC, [4, 4], 'a one-line flag');
    expect(a.approx).toBe(true);
    expect(a.quote).toBe('a one-line flag');
    expect(a.lines).toEqual([4, 4]);
    expect(a.prefix).toBe('');
  });
});

describe('locate', () => {
  it('finds a unique exact quote', () => {
    const a = captureAnchor(SRC, [3, 3], 'single release');
    const hit = locate(SRC, a);
    expect(SRC.slice(hit.start, hit.end)).toBe('single release');
    expect(hit.lines).toEqual([3, 3]);
  });
  it('disambiguates duplicates by prefix/suffix', () => {
    const second = SRC.lastIndexOf('The beta');
    const a = captureAnchor(SRC, [6, 6], 'The beta');
    // captureAnchor takes the first hit in the slice; rebuild for the second.
    const b = {
      ...a,
      prefix: SRC.slice(second - 32, second),
      suffix: SRC.slice(second + 8, second + 40),
    };
    expect(locate(SRC, b).start).toBe(second);
  });
  it('follows the quote when lines shift', () => {
    const a = captureAnchor(SRC, [3, 3], 'single release');
    const moved = 'intro\n\n' + SRC;
    expect(locate(moved, a).lines).toEqual([5, 5]);
  });
  it('returns null when the quote is gone', () => {
    const a = captureAnchor(SRC, [3, 3], 'single release');
    expect(locate(SRC.replace('single release', 'staged rollout'), a)).toBeNull();
  });
  it('approx and block anchors resolve by line range only', () => {
    const approx = captureAnchor(SRC, [4, 4], 'a one-line flag');
    expect(locate(SRC, approx)).toEqual({ start: null, end: null, lines: [4, 4] });
    expect(locate(SRC, blockAnchor([3, 4], 'paragraph', 'paragraph "We will ship"'))).toEqual({
      start: null,
      end: null,
      lines: [3, 4],
    });
    expect(locate(SRC, blockAnchor([40, 41], 'paragraph', 'x'))).toBeNull();
  });
});

describe('nthInLines / findAll', () => {
  it('counts occurrences before the hit inside the slice', () => {
    const second = SRC.lastIndexOf('The beta');
    expect(findAll(SRC, 'The beta')).toHaveLength(2);
    expect(nthInLines(SRC, [6, 6], second, 'The beta')).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit public/js/anchor.test.js`
Expected: FAIL — cannot resolve `./anchor.js`.

- [ ] **Step 3: Implement**

```js
// public/js/anchor.js
// Pure anchoring helpers shared by the browser (comments-ui.js) and the worker.
// An anchor pins a comment to the raw markdown source: an exact quote plus a
// little context, and the 1-based inclusive source line range it sits in.

export const CONTEXT_LEN = 32;

/**
 * @typedef {{ quote: string, approx: boolean, prefix: string, suffix: string,
 *   lines: [number, number], block?: { kind: string, label: string } }} Anchor
 */

/** 1-based line number containing `offset`. */
export function lineAt(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

function lineCount(source) {
  return lineAt(source, source.length);
}

/** Text of the 1-based inclusive line range and its offset in `source`. */
export function sliceLines(source, [startLine, endLine]) {
  const all = source.split('\n');
  let offset = 0;
  for (let i = 0; i < startLine - 1; i++) offset += all[i].length + 1;
  return { text: all.slice(startLine - 1, endLine).join('\n'), offset };
}

/** Regex matching `quote` with every whitespace run loosened to \s+. */
export function wsRegex(quote) {
  const escaped = quote
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('\\s+'), 'g');
}

export function findAll(source, quote) {
  const out = [];
  if (!quote) return out;
  for (let i = source.indexOf(quote); i !== -1; i = source.indexOf(quote, i + 1)) out.push(i);
  return out;
}

/** @returns {Anchor} */
export function captureAnchor(source, lines, selectedText) {
  const slice = sliceLines(source, lines);
  const m = selectedText.trim() ? wsRegex(selectedText).exec(slice.text) : null;
  if (!m) {
    return {
      quote: selectedText.trim().replace(/\s+/g, ' '),
      approx: true,
      prefix: '',
      suffix: '',
      lines,
    };
  }
  const start = slice.offset + m.index;
  const end = start + m[0].length;
  return {
    quote: m[0],
    approx: false,
    prefix: source.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: source.slice(end, end + CONTEXT_LEN),
    lines: [lineAt(source, start), lineAt(source, end - 1)],
  };
}

/** @returns {Anchor} */
export function blockAnchor(lines, kind, label) {
  return { quote: '', approx: false, prefix: '', suffix: '', lines, block: { kind, label } };
}

function contextScore(source, start, end, anchor) {
  let score = 0;
  if (anchor.prefix && source.slice(start - anchor.prefix.length, start) === anchor.prefix)
    score += 2;
  if (anchor.suffix && source.slice(end, end + anchor.suffix.length) === anchor.suffix) score += 2;
  return score;
}

/**
 * Exact match → whitespace-normalized match → null. Deliberately no fuzzy
 * matching: any edit inside the quote means the anchor is gone.
 * @param {string} source
 * @param {Anchor} anchor
 */
export function locate(source, anchor) {
  if (anchor.block || anchor.approx) {
    const [s, e] = anchor.lines;
    if (s < 1 || e < s || e > lineCount(source)) return null;
    return { start: null, end: null, lines: [s, e] };
  }
  let hits = findAll(source, anchor.quote).map((start) => ({
    start,
    end: start + anchor.quote.length,
  }));
  if (!hits.length) {
    hits = [...source.matchAll(wsRegex(anchor.quote))].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
    }));
  }
  if (!hits.length) return null;
  hits.sort(
    (a, b) =>
      contextScore(source, b.start, b.end, anchor) - contextScore(source, a.start, a.end, anchor) ||
      Math.abs(lineAt(source, a.start) - anchor.lines[0]) -
        Math.abs(lineAt(source, b.start) - anchor.lines[0])
  );
  const { start, end } = hits[0];
  return { start, end, lines: [lineAt(source, start), lineAt(source, end - 1)] };
}

/** 0-based index of the occurrence at `start` among occurrences in the line slice. */
export function nthInLines(source, lines, start, quote) {
  const slice = sliceLines(source, lines);
  return findAll(slice.text, quote).filter((i) => slice.offset + i < start).length;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run --project unit public/js/anchor.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add public/js/anchor.js public/js/anchor.test.js
git commit -m "feat(comments): pure source-quote anchoring helpers"
```

---

### Task 2: `feedback-format.js`

**Files:**

- Create: `public/js/feedback-format.js`
- Test: `public/js/feedback-format.test.js`

**Interfaces:**

- Consumes: `findAll` from `./anchor.js`.
- Produces: `formatFeedback(comments: { round: number, items: Item[] }, source: string, meta: { title: string, rev: number }, opts?: { includeAddressed?: boolean }): string`, where `Item` is the spec's data-model item (`id, tag, note, replace, anchor, status, carried`). Items are expected with anchors already resolved against `source` (the server does this on POST).

- [ ] **Step 1: Write the failing tests**

```js
// public/js/feedback-format.test.js
import { describe, it, expect } from 'vitest';
import { formatFeedback } from './feedback-format.js';

const SRC = 'Tail latency matters.\nMedian latency does not.\nShip soon.';
const item = (over) => ({
  id: 'c1',
  tag: 'fix',
  note: '',
  status: 'open',
  carried: 0,
  anchor: { quote: 'soon', approx: false, prefix: 'Ship ', suffix: '.', lines: [3, 3] },
  ...over,
});
const fmt = (items, opts, round = 1) =>
  formatFeedback({ round, items }, SRC, { title: 'Plan', rev: 3 }, opts);

describe('formatFeedback', () => {
  it('emits the legend header with title, rev and round', () => {
    const out = fmt([item({ note: 'Give a date' })], undefined, 2);
    expect(out.split('\n')[0]).toBe('# feedback · "Plan" · rev 3 · round 2');
    expect(out).toContain('L = line @ rev 3.');
    expect(out).toContain('keep=leave byte-identical');
  });
  it('formats an open fix with an indented note', () => {
    expect(fmt([item({ note: 'Give a date' })])).toContain('OPEN\nc1 fix L3 "soon"\n  Give a date');
  });
  it('omits the note line for cut and keep, and orders KEEP before OPEN', () => {
    const out = fmt([item({ id: 'c2', tag: 'cut' }), item({ id: 'k3', tag: 'keep' })]);
    expect(out).toContain('KEEP\nk3 L3 "soon"\n\nOPEN\nc2 cut L3 "soon"');
  });
  it('adds context only when the quote is ambiguous', () => {
    const dup = item({
      anchor: {
        quote: 'latency',
        approx: false,
        prefix: 'Tail ',
        suffix: ' matters.',
        lines: [1, 1],
      },
    });
    expect(fmt([dup])).toContain('c1 fix L1 "latency" <in "…Tail [latency] matters.…">');
    expect(fmt([item()])).not.toContain('<in');
  });
  it('elides quotes longer than 12 words and uses a line range', () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen';
    const out = formatFeedback(
      {
        round: 1,
        items: [
          item({ anchor: { quote: long, approx: false, prefix: '', suffix: '', lines: [2, 4] } }),
        ],
      },
      long,
      { title: 'T', rev: 0 }
    );
    expect(out).toContain('L2-4 "one two three four five … nine ten eleven twelve thirteen"');
  });
  it('marks approx quotes, block anchors, literal replacements and carried items', () => {
    const out = fmt(
      [
        item({ id: 'c1', anchor: { ...item().anchor, approx: true } }),
        item({
          id: 'c2',
          anchor: {
            quote: '',
            approx: false,
            prefix: '',
            suffix: '',
            lines: [1, 2],
            block: { kind: 'table', label: 'table under "Costs"' },
          },
          note: 'Add totals',
        }),
        item({ id: 'c3', replace: 'on 1 March' }),
        item({ id: 'c4', carried: 1, note: 'Still vague' }),
      ],
      undefined,
      2
    );
    expect(out).toContain('c1 fix L3 ~"soon"');
    expect(out).toContain('c2 fix L1-2 [table under "Costs"]\n  Add totals');
    expect(out).toContain('c3 fix L3 "soon" => "on 1 March"');
    expect(out).toContain('c4 fix L3 "soon" (carried: unchanged since round 1)');
  });
  it('puts general notes last, without id or anchor', () => {
    const out = fmt([item(), { id: 'c9', tag: 'general', note: 'Too salesy', status: 'open' }]);
    expect(out.endsWith('GENERAL\n  Too salesy')).toBe(true);
  });
  it('sorts OPEN in document order, skips addressed by default, escapes quotes/newlines', () => {
    const a = item({
      id: 'c2',
      anchor: { quote: 'Tail "x"\ny', approx: false, prefix: '', suffix: '', lines: [1, 2] },
    });
    const out = fmt([item({ id: 'c1' }), a, item({ id: 'c3', status: 'addressed' })]);
    expect(out.indexOf('c2 ')).toBeLessThan(out.indexOf('c1 '));
    expect(out).toContain('"Tail \\"x\\"\\ny"');
    expect(out).not.toContain('c3 ');
    expect(fmt([item({ id: 'c3', status: 'addressed' })], { includeAddressed: true })).toContain(
      'ADDRESSED\nc3 fix L3 "soon"'
    );
  });
  it('omits empty sections and says so when nothing is open', () => {
    expect(fmt([])).toMatch(/\n\n\(no open feedback\)$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit public/js/feedback-format.test.js`
Expected: FAIL — cannot resolve `./feedback-format.js`.

- [ ] **Step 3: Implement**

```js
// public/js/feedback-format.js
// Turns a note's comments into the compact plain-text block handed to an agent.
// Pure; used by the Copy feedback button now and by GET /feedback later.
import { findAll } from './anchor.js';

const ELIDE_OVER_WORDS = 12;
const ELIDE_KEEP_WORDS = 5;
const CONTEXT_CHARS = 16;

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const flat = (s) => s.replace(/\s+/g, ' ');

function quoteText(quote) {
  const words = quote.trim().split(/\s+/);
  if (words.length <= ELIDE_OVER_WORDS) return esc(quote);
  return esc(
    `${words.slice(0, ELIDE_KEEP_WORDS).join(' ')} … ${words.slice(-ELIDE_KEEP_WORDS).join(' ')}`
  );
}

function lineRef([s, e]) {
  return s === e ? `L${s}` : `L${s}-${e}`;
}

function anchorText(anchor, source) {
  if (anchor.block) return `[${anchor.block.label}]`;
  let out = `${anchor.approx ? '~' : ''}"${quoteText(anchor.quote)}"`;
  if (!anchor.approx && findAll(source, anchor.quote).length > 1) {
    const pre = flat(anchor.prefix.slice(-CONTEXT_CHARS));
    const post = flat(anchor.suffix.slice(0, CONTEXT_CHARS));
    out += ` <in "…${esc(pre)}[${quoteText(anchor.quote)}]${esc(post)}…">`;
  }
  return out;
}

function itemLines(item, source, round) {
  const showTag = item.tag !== 'keep';
  let head = `${item.id}${showTag ? ` ${item.tag}` : ''} ${lineRef(item.anchor.lines)} ${anchorText(item.anchor, source)}`;
  if (item.replace) head += ` => "${esc(item.replace)}"`;
  if (item.carried > 0) head += ` (carried: unchanged since round ${round - item.carried})`;
  const lines = [head];
  if (item.note && !item.replace) lines.push(...item.note.split('\n').map((l) => `  ${l}`));
  return lines;
}

const byPosition = (a, b) => a.anchor.lines[0] - b.anchor.lines[0] || a.id.localeCompare(b.id);

/**
 * @param {{ round: number, items: any[] }} comments
 * @param {string} source current markdown the anchors are resolved against
 * @param {{ title: string, rev: number }} meta
 * @param {{ includeAddressed?: boolean }} [opts]
 */
export function formatFeedback(comments, source, meta, opts = {}) {
  const { round, items } = comments;
  const out = [
    `# feedback · "${esc(meta.title)}" · rev ${meta.rev} · round ${round}`,
    `# Quotes are exact substrings of the markdown source (~ = rendered text, match loosely). L = line @ rev ${meta.rev}.`,
    "# fix=revise per note · cut=delete · q=answer, don't edit · keep=leave byte-identical",
    "# Edit the existing doc in place; change nothing else. Then list any ids you didn't apply + why.",
  ];
  const anchored = items.filter((i) => i.tag !== 'general' && i.anchor);
  const sections = [
    [
      'VIOLATED — kept text was changed; restore it',
      anchored.filter((i) => i.status === 'violated'),
    ],
    ['KEEP', anchored.filter((i) => i.tag === 'keep' && i.status === 'open')],
    ['OPEN', anchored.filter((i) => i.tag !== 'keep' && i.status === 'open')],
    ['ADDRESSED', opts.includeAddressed ? anchored.filter((i) => i.status === 'addressed') : []],
  ];
  let any = false;
  for (const [title, list] of sections) {
    if (!list.length) continue;
    any = true;
    out.push('', title);
    for (const item of [...list].sort(byPosition)) out.push(...itemLines(item, source, round));
  }
  const general = items.filter((i) => i.tag === 'general' && i.status === 'open' && i.note);
  if (general.length) {
    any = true;
    out.push('', 'GENERAL');
    for (const g of general) out.push(...g.note.split('\n').map((l) => `  ${l}`));
  }
  if (!any) out.push('', '(no open feedback)');
  return out.join('\n');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run --project unit public/js/feedback-format.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add public/js/feedback-format.js public/js/feedback-format.test.js
git commit -m "feat(comments): token-efficient agent feedback formatter"
```

---

### Task 3: Comment CRUD routes

**Files:**

- Modify: `src/worker.js` — add `commentsKey` beside `revKey` (~line 92); one line in `deleteNoteObjects` (~line 100); new routes directly after the `GET /api/files/:id/revisions/:n` handler (~line 735) and before `app.delete('/api/files/:id'`.
- Test: `src/comments.integration.test.js`

**Interfaces:**

- Consumes: `locate(source, anchor)` from `../public/js/anchor.js`; existing `loadMeta`, `isOwner`, `MAX_NOTE_BYTES`-style patterns in `worker.js`.
- Produces (HTTP, all owner-only → 404 otherwise):
  - `GET /api/files/:id/comments` → `200 { round, items }` (empty note: `{ round: 1, items: [] }`)
  - `POST /api/files/:id/comments` body `{ tag, note?, replace?, anchor? }` → `201 { item }`; `400` invalid body / cap / second general; `409 { error: 'Anchor not found' }` when the anchor does not locate in the current source
  - `PATCH /api/files/:id/comments/:cid` body any of `{ note, replace, tag, status }` → `200 { item }`; `400` invalid; `404` unknown cid
  - `DELETE /api/files/:id/comments/:cid` → `200 { success: true }`; `404` unknown cid

- [ ] **Step 1: Write the failing tests**

```js
// src/comments.integration.test.js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project integration src/comments.integration.test.js`
Expected: FAIL — first test gets 404 (route missing; the SPA catch-all / not-found answers).

- [ ] **Step 3: Implement**

At the top of `src/worker.js`, with the other imports:

```js
import { locate } from '../public/js/anchor.js';
```

Beside `revKey` / `snapshotKey`:

```js
const commentsKey = (id) => `comments:${id}`;
```

In `deleteNoteObjects`, after `await env.HISTORY.delete(revKey(id));`:

```js
await env.HISTORY.delete(commentsKey(id));
```

New section after the `GET /api/files/:id/revisions/:n` handler:

```js
// ── Comment routes ──────────────────────────────────────────────────────────
// Owner-only review comments, one KV value per note. Anchors are resolved
// against the current markdown source on write (see public/js/anchor.js).

const MAX_COMMENTS = 500;
const MAX_COMMENT_TEXT = 2000;
const COMMENT_TAGS = ['fix', 'cut', 'q', 'keep', 'general'];
const COMMENT_STATUSES = ['open', 'addressed'];

async function readComments(kv, id) {
  const raw = await kv.get(commentsKey(id));
  if (!raw) return { nextId: 1, round: 1, items: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { nextId: 1, round: 1, items: [] };
  }
}

/** Loads meta and answers null unless the caller owns the note. */
async function ownedMeta(c) {
  const meta = await loadMeta(c.env.HISTORY, c.req.param('id'));
  if (!meta || !isOwner(meta, c.get('user'))) {
    c.get('logger').warn('file.notFound', { fileId: c.req.param('id') });
    return null;
  }
  return meta;
}

const cleanText = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_COMMENT_TEXT) : '');

function cleanAnchor(a) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.lines)) return null;
  const lines = a.lines.map(Number);
  if (lines.length !== 2 || !lines.every(Number.isInteger)) return null;
  const anchor = {
    quote: typeof a.quote === 'string' ? a.quote.slice(0, MAX_COMMENT_TEXT) : '',
    approx: Boolean(a.approx),
    prefix: typeof a.prefix === 'string' ? a.prefix.slice(-64) : '',
    suffix: typeof a.suffix === 'string' ? a.suffix.slice(0, 64) : '',
    lines,
  };
  if (a.block && typeof a.block === 'object') {
    anchor.block = {
      kind: cleanText(a.block.kind).slice(0, 40),
      label: cleanText(a.block.label).slice(0, 200),
    };
  } else if (!anchor.quote) {
    return null;
  }
  return anchor;
}

app.get('/api/files/:id/comments', async (c) => {
  if (!(await ownedMeta(c))) return c.json({ error: 'File not found' }, 404);
  const { round, items } = await readComments(c.env.HISTORY, c.req.param('id'));
  return c.json({ round, items });
});

app.post('/api/files/:id/comments', async (c) => {
  const id = c.req.param('id');
  const meta = await ownedMeta(c);
  if (!meta) return c.json({ error: 'File not found' }, 404);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const tag = body.tag;
  if (!COMMENT_TAGS.includes(tag)) return c.json({ error: 'Invalid tag' }, 400);
  const note = cleanText(body.note);
  const replace = cleanText(body.replace);
  if ((tag === 'fix' || tag === 'q' || tag === 'general') && !note && !replace) {
    return c.json({ error: 'A note is required' }, 400);
  }

  const comments = await readComments(c.env.HISTORY, id);
  if (comments.items.length >= MAX_COMMENTS) return c.json({ error: 'Too many comments' }, 400);

  let anchor;
  if (tag === 'general') {
    if (comments.items.some((i) => i.tag === 'general')) {
      return c.json({ error: 'General note already exists' }, 400);
    }
  } else {
    anchor = cleanAnchor(body.anchor);
    if (!anchor) return c.json({ error: 'Invalid anchor' }, 400);
    const obj = await c.env.MD_FILES.get(`${id}.md`);
    if (!obj) return c.json({ error: 'File not found' }, 404);
    const hit = locate(await obj.text(), anchor);
    if (!hit) return c.json({ error: 'Anchor not found' }, 409);
    anchor.lines = hit.lines;
  }

  const item = {
    id: `${tag === 'keep' ? 'k' : 'c'}${comments.nextId}`,
    tag,
    note,
    ...(replace ? { replace } : {}),
    ...(anchor ? { anchor } : {}),
    rev: meta.currentRev || 0,
    status: 'open',
    carried: 0,
    authorId: c.get('user').id,
    createdAt: new Date().toISOString(),
  };
  comments.nextId += 1;
  comments.items.push(item);
  await c.env.HISTORY.put(commentsKey(id), JSON.stringify(comments));
  c.get('logger').info('comment.create', { fileId: id, commentId: item.id, tag });
  return c.json({ item }, 201);
});

app.patch('/api/files/:id/comments/:cid', async (c) => {
  const id = c.req.param('id');
  if (!(await ownedMeta(c))) return c.json({ error: 'File not found' }, 404);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const comments = await readComments(c.env.HISTORY, id);
  const item = comments.items.find((i) => i.id === c.req.param('cid'));
  if (!item) return c.json({ error: 'Comment not found' }, 404);

  if (body.tag !== undefined && body.tag !== item.tag) {
    const fixed = ['keep', 'general'];
    if (!COMMENT_TAGS.includes(body.tag) || fixed.includes(body.tag) || fixed.includes(item.tag)) {
      return c.json({ error: 'Invalid tag change' }, 400);
    }
    item.tag = body.tag;
  }
  if (body.status !== undefined) {
    if (!COMMENT_STATUSES.includes(body.status)) return c.json({ error: 'Invalid status' }, 400);
    item.status = body.status;
  }
  if (body.note !== undefined) item.note = cleanText(body.note);
  if (body.replace !== undefined) {
    const replace = cleanText(body.replace);
    if (replace) item.replace = replace;
    else delete item.replace;
  }
  await c.env.HISTORY.put(commentsKey(id), JSON.stringify(comments));
  return c.json({ item });
});

app.delete('/api/files/:id/comments/:cid', async (c) => {
  const id = c.req.param('id');
  if (!(await ownedMeta(c))) return c.json({ error: 'File not found' }, 404);
  const comments = await readComments(c.env.HISTORY, id);
  const before = comments.items.length;
  comments.items = comments.items.filter((i) => i.id !== c.req.param('cid'));
  if (comments.items.length === before) return c.json({ error: 'Comment not found' }, 404);
  await c.env.HISTORY.put(commentsKey(id), JSON.stringify(comments));
  c.get('logger').info('comment.delete', { fileId: id, commentId: c.req.param('cid') });
  return c.json({ success: true });
});
```

Check `PUBLIC_READ_RE` (~line 285) is unchanged: it must **not** match `/comments`, so anonymous callers get 401 from the auth middleware. Its current pattern (`/api/files/:id` plus optional `/revisions…`) already excludes it.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run --project integration src/comments.integration.test.js`
Expected: PASS, 9 tests.

Run: `pnpm typecheck`
Expected: no errors (this now type-checks `public/js/anchor.js` transitively; fix JSDoc there if it complains).

- [ ] **Step 5: Commit**

```bash
git add src/worker.js src/comments.integration.test.js
git commit -m "feat(api): owner-only comment CRUD with source-anchored validation"
```

---

### Task 4: `data-line` stamping plugin

**Files:**

- Create: `public/js/source-lines.js`
- Test: `public/js/source-lines.test.js`
- Modify: `package.json` (devDependency), `public/js/app.js` (~line 34, after `const md = window.markdownit({...});`)

**Interfaces:**

- Consumes: a markdown-it instance.
- Produces: `sourceLines(md): void` — markdown-it plugin. Every block-level opening/self-closing token with a `map` renders with `data-line="<start>,<end>"`, 1-based inclusive. For fenced/indented code the attribute lands on the inner `<code>` (markdown-it puts fence attrs there).

- [ ] **Step 1: Add the test-only dependency**

Run: `pnpm add -D markdown-it@14.1.0`
(Matches the CDN version in `public/index.html`. The browser still loads the CDN copy.)

- [ ] **Step 2: Write the failing tests**

````js
// public/js/source-lines.test.js
import { describe, it, expect } from 'vitest';
import markdownit from 'markdown-it';
import { sourceLines } from './source-lines.js';

const md = markdownit({ html: true }).use(sourceLines);
const SRC = [
  '# Title',
  '',
  'Para one',
  'still one.',
  '',
  '- a',
  '- b',
  '',
  '```js',
  'x()',
  '```',
].join('\n');

describe('sourceLines', () => {
  const html = md.render(SRC);
  it('stamps 1-based inclusive ranges on blocks', () => {
    expect(html).toContain('<h1 data-line="1,1">');
    expect(html).toContain('<p data-line="3,4">');
    expect(html).toContain('<ul data-line="6,7">');
    expect(html).toContain('<li data-line="6,6">');
  });
  it('stamps fenced code on the code element', () => {
    expect(html).toMatch(
      /<code class="language-js" data-line="9,11">|<code data-line="9,11" class="language-js">/
    );
  });
  it('does not stamp closing or inline tokens', () => {
    expect(html).not.toContain('</p data-line');
    expect(md.renderInline('a *b*')).not.toContain('data-line');
  });
});
````

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run --project unit public/js/source-lines.test.js`
Expected: FAIL — cannot resolve `./source-lines.js`.

- [ ] **Step 4: Implement**

```js
// public/js/source-lines.js
// markdown-it plugin: stamp each rendered block with the 1-based inclusive
// source line range it came from, so a DOM selection can be mapped back to the
// raw markdown (see anchor.js).
export function sourceLines(md) {
  md.core.ruler.push('source_lines', (state) => {
    for (const token of state.tokens) {
      if (!token.map || !token.block || token.nesting === -1 || token.type === 'inline') continue;
      token.attrSet('data-line', `${token.map[0] + 1},${token.map[1]}`);
    }
  });
}
```

In `public/js/app.js`, add to the imports at the top:

```js
import { sourceLines } from './source-lines.js';
```

and directly after the `const md = window.markdownit({ ... });` statement:

```js
md.use(sourceLines);
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run --project unit public/js/source-lines.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml public/js/source-lines.js public/js/source-lines.test.js public/js/app.js
git commit -m "feat(frontend): stamp rendered blocks with source line ranges"
```

---

### Task 5: Review UI — `comments-ui.js`, markup, styles, wiring

**Files:**

- Create: `public/js/comments-ui.js`
- Modify: `public/index.html` (toolbar ~line 215; `.viewer-scroll` ~line 259–276)
- Modify: `public/css/style.css` (append a new section at the end, before any trailing media-query block is fine — it carries its own media query)
- Modify: `public/js/app.js` (imports; after DOM refs; `viewFile`; `applyOwnerControls`; `enterEditMode`; `openRevisions`; `headerLocked`; `showInputArea`; `renderMarkdown`)

**Interfaces:**

- Consumes: `captureAnchor`, `blockAnchor`, `locate`, `nthInLines`, `wsRegex` from `./anchor.js`; `formatFeedback` from `./feedback-format.js`; routes from Task 3; `data-line` from Task 4.
- Produces: `initComments(deps): Controller`
  - `deps = { root: HTMLElement, scroller: HTMLElement, rail: HTMLElement, reviewBtn: HTMLButtonElement, copyBtn: HTMLButtonElement, api: (path, opts) => Promise<Response>, getNote: () => ({ id, owned, currentRev } | null), getSource: () => string | null, getTitle: () => string, flashCopied: (btn) => void, onModeChange: () => void }`
  - `Controller = { load(): Promise<void>, clear(): void, refresh(): void, setReviewMode(on: boolean): void, isReviewing(): boolean }`

There is no unit test for this file (it is DOM glue over tested pure modules); it is verified in the browser in Task 6. Keep logic that _can_ be pure in `anchor.js`.

- [ ] **Step 1: Markup**

In `public/index.html`, inside `.viewer-toolbar-right`, directly **before** the `<button id="edit-btn" …>` line:

```html
<button id="review-btn" class="text-btn" aria-pressed="false" hidden>Review</button>
<button id="copy-feedback-btn" class="text-btn" data-secondary hidden>Copy feedback</button>
```

Directly **after** the `<article id="rendered-output" class="markdown-body"></article>` line:

```html
<aside id="comments-rail" class="comments-rail" aria-label="Review comments" hidden></aside>
```

- [ ] **Step 2: Styles**

Append to `public/css/style.css`:

```css
/* ── Review comments (desktop, phase A1) ─────────────────────────────────── */

:root {
  --review-fix: rgba(255, 212, 0, 0.35);
  --review-keep: rgba(46, 160, 67, 0.25);
  --review-cut: rgba(207, 34, 46, 0.2);
}

::highlight(review-fix) {
  background-color: var(--review-fix);
}
::highlight(review-keep) {
  background-color: var(--review-keep);
}
::highlight(review-cut) {
  background-color: var(--review-cut);
  text-decoration: line-through;
}
::highlight(review-active) {
  background-color: var(--accent-subtle);
}

#review-btn[aria-pressed='true'] {
  color: var(--accent);
}

.viewer-scroll.reviewing {
  position: relative;
}
.viewer-scroll.reviewing .markdown-body {
  padding-right: max(316px, calc((100% - 860px) / 2));
}
.viewer-scroll.reviewing [data-line].review-block {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
  border-radius: 2px;
}

.comments-rail {
  position: absolute;
  top: 0;
  right: 16px;
  width: 280px;
}
.comment-card {
  position: absolute;
  left: 0;
  right: 0;
  padding: 8px 10px;
  font-size: 0.8125rem;
  line-height: 1.4;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}
.comment-card.is-active {
  border-color: var(--accent);
  box-shadow: var(--shadow-md);
  z-index: 2;
}
.comment-card.is-addressed {
  opacity: 0.6;
}
.comment-card[data-tag='keep'] {
  border-left: 3px solid #2ea043;
}
.comment-card[data-tag='cut'] {
  border-left: 3px solid var(--danger);
}
.comment-card-head {
  display: flex;
  gap: 6px;
  color: var(--text-tertiary);
  font-size: 0.75rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.comment-card-note {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.comment-card-actions {
  display: none;
  gap: 10px;
  margin-top: 6px;
}
.comment-card.is-active .comment-card-actions {
  display: flex;
}
.comment-card-actions button {
  font-size: 0.75rem;
  padding: 0;
}
.comments-general {
  position: static;
  margin-bottom: 8px;
}

.comment-popover {
  position: absolute;
  z-index: 60;
  width: 300px;
  padding: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
}
.comment-tags {
  display: flex;
  gap: 4px;
  margin-bottom: 6px;
}
.comment-tags button {
  font-size: 0.75rem;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}
.comment-tags button[aria-pressed='true'] {
  background: var(--accent-subtle);
  border-color: var(--accent);
  color: var(--accent);
}
.comment-popover textarea,
.comment-popover input {
  width: 100%;
  font: inherit;
  font-size: 0.8125rem;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  resize: vertical;
}
.comment-popover input {
  margin-top: 6px;
}
.comment-popover-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 6px;
  font-size: 0.6875rem;
  color: var(--text-tertiary);
}
.comment-error {
  color: var(--danger);
}

.comment-gutter-btn {
  position: absolute;
  z-index: 5;
  width: 22px;
  height: 22px;
  line-height: 20px;
  padding: 0;
  text-align: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg);
  color: var(--text-secondary);
  cursor: pointer;
}

/* A1 is desktop-only; tablet and mobile review UI arrive in A2. */
@media (max-width: 1023px) {
  #review-btn,
  #copy-feedback-btn,
  .comments-rail,
  .comment-gutter-btn {
    display: none !important;
  }
  .viewer-scroll.reviewing .markdown-body {
    padding-right: max(24px, calc((100% - 860px) / 2));
  }
}
```

- [ ] **Step 3: Implement `comments-ui.js`**

```js
// public/js/comments-ui.js
// Review mode for the rendered note: select text (or a block) to comment,
// highlights via the CSS Custom Highlight API, a margin rail of cards, and
// "Copy feedback". All anchoring maths lives in anchor.js; this file is DOM glue.
import { captureAnchor, blockAnchor, locate, nthInLines, wsRegex } from './anchor.js';
import { formatFeedback } from './feedback-format.js';

const TAGS = ['fix', 'cut', 'q', 'keep'];
const NOTE_OPTIONAL = new Set(['cut', 'keep']);
const HIGHLIGHT_FOR = {
  fix: 'review-fix',
  q: 'review-fix',
  keep: 'review-keep',
  cut: 'review-cut',
};
const CARD_GAP = 8;
const canHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}

function parseLines(node) {
  const [s, e] = node.dataset.line.split(',').map(Number);
  return [s, e];
}

/** Smallest [data-line] element covering the line range, or null. */
function blockFor(root, [s, e]) {
  let best = null;
  for (const node of root.querySelectorAll('[data-line]')) {
    const [bs, be] = parseLines(node);
    if (bs > s || be < e) continue;
    if (!best || be - bs < best.span) best = { node, span: be - bs };
  }
  return best ? best.node : null;
}

/** DOM Range for the nth whitespace-tolerant match of `quote` inside `scope`. */
function rangeForQuote(scope, quote, nth) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.data;
  }
  const matches = [...text.matchAll(wsRegex(quote))];
  const m = matches[Math.min(nth, matches.length - 1)];
  if (!m) return null;
  const at = (offset, preferEnd) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { node, start } = nodes[i];
      if (offset > start || (offset === start && !preferEnd) || i === 0) {
        return [node, Math.min(offset - start, node.data.length)];
      }
    }
    return null;
  };
  const range = document.createRange();
  range.setStart(...at(m.index, false));
  range.setEnd(...at(m.index + m[0].length, true));
  return range;
}

function nearestHeadingText(node) {
  for (let cur = node; cur; cur = cur.previousElementSibling || cur.parentElement) {
    if (cur !== node && /^H[1-6]$/.test(cur.tagName)) return cur.textContent.trim();
    if (cur.id === 'rendered-output') break;
  }
  return '';
}

function describeBlock(node) {
  const under = nearestHeadingText(node);
  const suffix = under ? ` under "${under}"` : '';
  const words = node.textContent.trim().split(/\s+/).slice(0, 5).join(' ');
  switch (node.tagName) {
    case 'CODE': {
      const lang = (node.className.match(/language-(\S+)/) || [])[1];
      return { kind: 'code', label: `code block${lang ? `, ${lang}` : ''}${suffix}` };
    }
    case 'TABLE':
      return { kind: 'table', label: `table${suffix}` };
    case 'UL':
    case 'OL':
      return { kind: 'list', label: `list${suffix}` };
    case 'BLOCKQUOTE':
      return { kind: 'quote', label: `blockquote "${words}…"` };
    default:
      if (/^H[1-6]$/.test(node.tagName)) {
        return { kind: 'section', label: `section "${node.textContent.trim()}"` };
      }
      return { kind: 'paragraph', label: `paragraph "${words}…"` };
  }
}

export function initComments(deps) {
  const { root, scroller, rail, reviewBtn, copyBtn, api } = deps;
  let data = { round: 1, items: [] };
  let reviewing = false;
  let activeId = null;
  let popover = null;
  let gutterBtn = null;
  /** @type {Map<string, { range: Range|null, block: Element|null }>} */
  let targets = new Map();

  const note = () => deps.getNote();
  const base = () => `/api/files/${encodeURIComponent(note().id)}/comments`;

  // ── Resolve + paint ───────────────────────────────────────────────────────

  function resolveTargets() {
    targets = new Map();
    const source = deps.getSource();
    if (!source) return;
    for (const item of data.items) {
      if (!item.anchor) continue;
      const hit = locate(source, item.anchor);
      if (!hit) continue;
      const block = blockFor(root, hit.lines);
      let range = null;
      if (!item.anchor.block && block) {
        const nth =
          hit.start == null
            ? 0
            : nthInLines(source, parseLines(block), hit.start, item.anchor.quote);
        range = rangeForQuote(block, item.anchor.quote, nth);
      }
      targets.set(item.id, { range, block });
    }
  }

  function paintHighlights() {
    if (!canHighlight) return;
    for (const name of [...new Set(Object.values(HIGHLIGHT_FOR)), 'review-active']) {
      CSS.highlights.delete(name);
    }
    for (const node of root.querySelectorAll('.review-block'))
      node.classList.remove('review-block');
    if (!reviewing) return;
    const groups = {};
    for (const item of data.items) {
      const t = targets.get(item.id);
      if (!t || item.status !== 'open') continue;
      if (t.range) (groups[HIGHLIGHT_FOR[item.tag]] ||= []).push(t.range);
      if (item.id === activeId) {
        if (t.range) CSS.highlights.set('review-active', new Highlight(t.range));
        else if (t.block) t.block.classList.add('review-block');
      }
    }
    for (const [name, ranges] of Object.entries(groups)) {
      CSS.highlights.set(name, new Highlight(...ranges));
    }
  }

  function targetTop(item) {
    const t = targets.get(item.id);
    const rect =
      t && (t.range ? t.range.getBoundingClientRect() : t.block?.getBoundingClientRect());
    if (!rect) return null;
    return rect.top - scroller.getBoundingClientRect().top;
  }

  function renderRail() {
    rail.replaceChildren();
    rail.hidden = !reviewing;
    if (!reviewing) return;

    const general = data.items.find((i) => i.tag === 'general');
    const generalCard = el('div', { className: 'comment-card comments-general' }, [
      el('div', { className: 'comment-card-head', textContent: 'General note' }),
      el('div', {
        className: 'comment-card-note',
        textContent: general ? general.note : 'Add a note about the whole document',
      }),
    ]);
    generalCard.addEventListener('click', () => openComposer({ general }));
    rail.append(generalCard);

    const placed = data.items
      .filter((i) => i.anchor)
      .map((item) => ({ item, top: targetTop(item) }))
      .sort((a, b) => (a.top ?? Infinity) - (b.top ?? Infinity));
    let floor = generalCard.offsetTop + generalCard.offsetHeight + CARD_GAP;
    for (const { item, top } of placed) {
      const card = buildCard(item, top == null);
      rail.append(card);
      const y = Math.max(top ?? floor, floor);
      card.style.top = `${y}px`;
      floor = y + card.offsetHeight + CARD_GAP;
    }
    rail.style.height = `${floor}px`;
  }

  function buildCard(item, orphaned) {
    const quote = item.anchor.block ? `[${item.anchor.block.label}]` : `"${item.anchor.quote}"`;
    const card = el('div', { className: 'comment-card' }, [
      el('div', {
        className: 'comment-card-head',
        textContent: `${item.id} · ${item.tag}${orphaned ? ' · anchor not found' : ''} · ${quote}`,
      }),
    ]);
    card.dataset.id = item.id;
    card.dataset.tag = item.tag;
    card.classList.toggle('is-active', item.id === activeId);
    card.classList.toggle('is-addressed', item.status === 'addressed');
    if (item.replace) {
      card.append(el('div', { className: 'comment-card-note', textContent: `→ ${item.replace}` }));
    }
    if (item.note)
      card.append(el('div', { className: 'comment-card-note', textContent: item.note }));

    const action = (label, fn, danger) => {
      const b = el('button', {
        className: `text-btn${danger ? ' danger' : ''}`,
        textContent: label,
      });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    card.append(
      el('div', { className: 'comment-card-actions' }, [
        action('Edit', () => openComposer({ existing: item })),
        action(item.status === 'open' ? 'Resolve' : 'Reopen', () =>
          patch(item.id, { status: item.status === 'open' ? 'addressed' : 'open' })
        ),
        action('Delete', () => remove(item.id), true),
      ])
    );
    card.addEventListener('click', () => activate(item.id, { scroll: true }));
    return card;
  }

  function repaint() {
    resolveTargets();
    paintHighlights();
    renderRail();
    copyBtn.hidden = !(note() && note().owned && data.items.length);
  }

  function activate(id, { scroll = false } = {}) {
    activeId = id;
    paintHighlights();
    for (const card of rail.querySelectorAll('.comment-card[data-id]')) {
      card.classList.toggle('is-active', card.dataset.id === id);
    }
    const t = targets.get(id);
    const node = t && (t.range ? t.range.startContainer.parentElement : t.block);
    if (scroll && node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ── API ───────────────────────────────────────────────────────────────────

  async function create(body) {
    const res = await api(base(), { method: 'POST', body: JSON.stringify(body) });
    if (res.status === 409) {
      await load();
      throw new Error('The note changed. Select the text again.');
    }
    if (!res.ok) throw new Error((await res.json()).error || 'Could not save');
    const { item } = await res.json();
    data.items.push(item);
    activeId = item.id;
    repaint();
  }

  async function patch(id, body) {
    const res = await api(`${base()}/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not save');
    const { item } = await res.json();
    data.items = data.items.map((i) => (i.id === id ? item : i));
    repaint();
  }

  async function remove(id) {
    const res = await api(`${base()}/${id}`, { method: 'DELETE' });
    if (!res.ok) return;
    data.items = data.items.filter((i) => i.id !== id);
    if (activeId === id) activeId = null;
    repaint();
  }

  async function load() {
    data = { round: 1, items: [] };
    activeId = null;
    const current = note();
    if (current && current.owned) {
      try {
        const res = await api(base());
        if (res.ok && note() && note().id === current.id) data = await res.json();
      } catch {}
    }
    repaint();
  }

  // ── Composer popover ──────────────────────────────────────────────────────

  function closeComposer() {
    if (popover) popover.remove();
    popover = null;
  }

  /** opts: { anchor, rect } for new | { existing } to edit | { general } for the doc note. */
  function openComposer(opts) {
    closeComposer();
    const existing = opts.existing || opts.general || null;
    const isGeneral = 'general' in opts;
    let tag = existing ? existing.tag : isGeneral ? 'general' : 'fix';

    const tagRow = el('div', { className: 'comment-tags' });
    const tagButtons = TAGS.map((t, i) => {
      const b = el('button', { type: 'button', textContent: `${i + 1} ${t}` });
      b.addEventListener('click', () => setTag(t));
      tagRow.append(b);
      return b;
    });
    const noteInput = el('textarea', { rows: 2, placeholder: 'Add a note' });
    const replaceInput = el('input', {
      type: 'text',
      placeholder: 'Replace with (optional, exact)',
    });
    const error = el('span', { className: 'comment-error' });
    const foot = el('div', { className: 'comment-popover-foot' }, [
      el('span', { textContent: '⌘↵ save · esc cancel' }),
      error,
    ]);
    if (existing) {
      noteInput.value = existing.note || '';
      replaceInput.value = existing.replace || '';
    }
    // keep/general ids are fixed (see PATCH rules), so their tag cannot change.
    const tagLocked = isGeneral || (existing && existing.tag === 'keep');
    const hasQuote = !isGeneral && !(opts.anchor || existing.anchor).block;

    function setTag(next) {
      if (tagLocked || (existing && next === 'keep')) return;
      tag = next;
      tagButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(TAGS[i] === tag)));
      replaceInput.hidden = !(hasQuote && tag === 'fix');
    }

    popover = el('div', { className: 'comment-popover' }, [
      ...(tagLocked ? [] : [tagRow]),
      noteInput,
      replaceInput,
      foot,
    ]);
    setTag(tag);
    if (tagLocked) replaceInput.hidden = true;

    async function save() {
      const body = {
        note: noteInput.value,
        replace: replaceInput.hidden ? '' : replaceInput.value,
      };
      if (!NOTE_OPTIONAL.has(tag) && !body.note.trim() && !body.replace.trim()) {
        error.textContent = 'Add a note first';
        return;
      }
      try {
        if (existing) await patch(existing.id, tagLocked ? body : { ...body, tag });
        else await create({ ...body, tag, ...(isGeneral ? {} : { anchor: opts.anchor }) });
        closeComposer();
        window.getSelection().removeAllRanges();
      } catch (e) {
        error.textContent = e.message;
      }
    }

    popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeComposer();
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
      else if (!tagLocked && /^[1-4]$/.test(e.key) && (e.altKey || !noteInput.value)) {
        e.preventDefault();
        setTag(TAGS[Number(e.key) - 1]);
      }
    });

    scroller.append(popover);
    const host = scroller.getBoundingClientRect();
    const rect = opts.rect || rail.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left - host.left, 8), host.width - 316);
    popover.style.left = `${left}px`;
    popover.style.top = `${rect.bottom - host.top + 8}px`;
    noteInput.focus();
  }

  // ── Selection + gutter ────────────────────────────────────────────────────

  function closestBlock(node) {
    const e = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return e ? e.closest('[data-line]') : null;
  }

  function onSelectionEnd(e) {
    if (!reviewing || (popover && popover.contains(e.target))) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    const first = closestBlock(range.startContainer);
    const last = closestBlock(range.endContainer);
    if (!first || !last) return;
    const lines = [
      Math.min(parseLines(first)[0], parseLines(last)[0]),
      Math.max(parseLines(first)[1], parseLines(last)[1]),
    ];
    const anchor = captureAnchor(deps.getSource(), lines, sel.toString());
    if (!anchor.quote) return;
    openComposer({ anchor, rect: range.getBoundingClientRect() });
  }

  function onClick(e) {
    if (!reviewing) return;
    if (popover && !popover.contains(e.target) && window.getSelection().isCollapsed)
      closeComposer();
    if (!root.contains(e.target) || !window.getSelection().isCollapsed) return;
    for (const item of data.items) {
      const t = targets.get(item.id);
      if (!t || !t.range) continue;
      const hit = [...t.range.getClientRects()].some(
        (r) =>
          e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      );
      if (hit) {
        activate(item.id);
        rail.querySelector(`[data-id="${item.id}"]`)?.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
  }

  function onHover(e) {
    if (!reviewing || popover) return;
    if (gutterBtn && gutterBtn.contains(e.target)) return;
    let block = e.target.closest ? e.target.closest('[data-line]') : null;
    // Comment on the outermost stamped block (a whole list or quote, not one item).
    while (block && block.parentElement.closest('[data-line]')) {
      block = block.parentElement.closest('[data-line]');
    }
    if (!block || !root.contains(block)) return;
    if (!gutterBtn) {
      gutterBtn = el('button', {
        className: 'comment-gutter-btn',
        type: 'button',
        textContent: '+',
        title: 'Comment on this block',
      });
      gutterBtn.setAttribute('aria-label', 'Comment on this block');
      gutterBtn.addEventListener('click', () => {
        const target = gutterBtn.block;
        const { kind, label } = describeBlock(target);
        openComposer({
          anchor: blockAnchor(parseLines(target), kind, label),
          rect: target.getBoundingClientRect(),
        });
      });
      scroller.append(gutterBtn);
    }
    const host = scroller.getBoundingClientRect();
    const rect = block.getBoundingClientRect();
    gutterBtn.block = block;
    gutterBtn.hidden = false;
    gutterBtn.style.top = `${rect.top - host.top}px`;
    gutterBtn.style.left = `${Math.max(rect.left - host.left - 30, 0)}px`;
  }

  // ── Mode + public API ─────────────────────────────────────────────────────

  function setReviewMode(on) {
    const next = Boolean(on && note() && note().owned);
    if (next === reviewing) return;
    reviewing = next;
    reviewBtn.setAttribute('aria-pressed', String(reviewing));
    scroller.classList.toggle('reviewing', reviewing);
    if (!reviewing) {
      closeComposer();
      if (gutterBtn) gutterBtn.hidden = true;
      activeId = null;
    }
    repaint();
    deps.onModeChange();
  }

  reviewBtn.addEventListener('click', () => setReviewMode(!reviewing));
  copyBtn.addEventListener('click', () => {
    const current = note();
    if (!current) return;
    const text = formatFeedback(data, deps.getSource(), {
      title: deps.getTitle(),
      rev: current.currentRev,
    });
    navigator.clipboard.writeText(text);
    deps.flashCopied(copyBtn);
  });
  document.addEventListener('mouseup', onSelectionEnd);
  document.addEventListener('click', onClick);
  root.addEventListener('mouseover', onHover);
  window.addEventListener('resize', () => reviewing && renderRail());

  return {
    load,
    clear() {
      data = { round: 1, items: [] };
      setReviewMode(false);
      repaint();
    },
    refresh: repaint,
    setReviewMode,
    isReviewing: () => reviewing,
  };
}
```

- [ ] **Step 4: Wire into `app.js`**

Add to the imports at the top:

```js
import { initComments } from './comments-ui.js';
```

After the DOM refs block (after `const editorSaveBtn = …`), add refs:

```js
const reviewBtn = document.getElementById('review-btn');
const copyFeedbackBtn = document.getElementById('copy-feedback-btn');
const commentsRail = document.getElementById('comments-rail');
```

`flashCopied`, `api`, `showHeader` and `applyOwnerControls` are function declarations (hoisted), so the controller can be created right after the `let currentNote = null;` line (~line 344):

```js
const comments = initComments({
  root: renderedOutput,
  scroller: document.querySelector('.viewer-scroll'),
  rail: commentsRail,
  reviewBtn,
  copyBtn: copyFeedbackBtn,
  api,
  getNote: () => currentNote,
  getSource: () => currentRawMarkdown,
  getTitle: () => currentFilename || 'Untitled',
  flashCopied,
  // Review mode pins the header (see headerLocked).
  onModeChange: () => showHeader(),
});
```

In `viewFile`, directly after `applyOwnerControls();`:

```js
comments.setReviewMode(false);
comments.load();
```

In `applyOwnerControls`, after the `editBtn.hidden = …` line:

```js
reviewBtn.hidden = !owned || editing;
if (!owned) copyFeedbackBtn.hidden = true;
```

In `renderMarkdown`, after `wrapTables();` (the rendered DOM was replaced, so ranges are stale):

```js
comments.refresh();
```

At the top of `enterEditMode` (after its guard `return`) and at the top of `openRevisions`:

```js
comments.setReviewMode(false);
```

In `showInputArea`, next to where `currentFileId = null;` is set:

```js
comments.clear();
```

In `headerLocked()`, add one operand to the `||` chain:

```js
comments.isReviewing() ||
```

`renderMarkdown` is called before `comments` exists only if a render happens during module evaluation; it does not (renders follow `checkAuth()`), so no guard is needed. `comments.refresh()` inside `renderMarkdown` runs before `currentNote` is updated in `viewFile`; that is harmless because `viewFile` then calls `comments.load()`, which repaints.

- [ ] **Step 5: Static checks**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all pass. (If prettier reflows the long lines above, accept its output: `pnpm exec prettier --write public/js/comments-ui.js public/css/style.css public/index.html`.)

- [ ] **Step 6: Commit**

```bash
git add public/js/comments-ui.js public/js/app.js public/index.html public/css/style.css
git commit -m "feat(frontend): desktop review mode with anchored comments and Copy feedback"
```

---

### Task 6: Seed scenario, browser verification, docs

**Files:**

- Modify: `src/seed.js` (`SEED_IDS`, a source constant, the `notes` array, a comments write at the end of `seedScenarios`)
- Modify: `src/dev.integration.test.js` only if it asserts an exact seeded-note count (check; bump the number if so)
- Modify: `CLAUDE.md`
- Modify: `.claude/skills/verifier-web/SKILL.md` (add the scenario to its seed list)

**Interfaces:**

- Consumes: everything above.
- Produces: seeded note `SEED_IDS.review` ("Review me") owned by `user_local_dev` with four comments: exact `fix`, `keep`, block `q`, and `general`.

- [ ] **Step 1: Seed data**

In `src/seed.js`, add to `SEED_IDS`:

```js
review: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
```

Add near the other content constants:

```js
const REVIEW = [
  '# Rollout plan', // 1
  '', // 2
  'We will ship to all customers in a single release after the beta ends.', // 3
  'Rollback is a **one-line** flag flip.', // 4
  '', // 5
  '## Costs', // 6
  '', // 7
  '| Item | Monthly |', // 8
  '| --- | --- |', // 9
  '| Workers | $5 |', // 10
  '| R2 | $2 |', // 11
  '', // 12
  'The beta is small. The beta is closed.', // 13
  '',
].join('\n');

const REVIEW_COMMENTS = {
  nextId: 5,
  round: 1,
  items: [
    {
      id: 'c1',
      tag: 'fix',
      note: 'Stage it: 5% → 25% → 100%',
      anchor: {
        quote: 'all customers in a single release',
        approx: false,
        prefix: 'We will ship to ',
        suffix: ' after the beta ends.',
        lines: [3, 3],
      },
    },
    {
      id: 'k2',
      tag: 'keep',
      note: '',
      anchor: { quote: 'Rollback is a', approx: false, prefix: '', suffix: '', lines: [4, 4] },
    },
    {
      id: 'c3',
      tag: 'q',
      note: 'Are these list prices?',
      anchor: {
        quote: '',
        approx: false,
        prefix: '',
        suffix: '',
        lines: [8, 11],
        block: { kind: 'table', label: 'table under "Costs"' },
      },
    },
    { id: 'c4', tag: 'general', note: 'Tone is too salesy overall' },
  ].map((i) => ({
    ...i,
    rev: 0,
    status: 'open',
    carried: 0,
    authorId: OWNER,
    createdAt: ago(0),
  })),
};
```

Add to the `notes` array (same `note(...)` helper and default owner as the neighbors):

```js
note(SEED_IDS.review, 'Review me', REVIEW, { createdDays: 0 }),
```

At the end of `seedScenarios`, after notes are written:

```js
await env.HISTORY.put(`comments:${SEED_IDS.review}`, JSON.stringify(REVIEW_COMMENTS));
```

- [ ] **Step 2: Run the suite**

Run: `pnpm test`
Expected: PASS. If `src/dev.integration.test.js` fails on a seeded-note count, raise that expected count by 1 and re-run.

- [ ] **Step 3: Verify in a real browser**

Invoke the `verifier-web` skill and follow it (`pnpm uat`, then drive the browser; `pnpm uat:stop` when done). At **1280×800**, light then dark, on the "Review me" note, confirm each and capture a screenshot of the first and last:

1. Review off: no highlights, no rail, selecting text does nothing special.
2. Click **Review**: header stays pinned while scrolling; "all customers in a single release" is yellow, "Rollback is a" is green; rail shows General + `c1`, `k2`, `c3`, tops aligned to their anchors, none overlapping.
3. Click the `c3` card: the Costs table gets the accent outline and scrolls to center.
4. Select `small` in the last paragraph → popover opens under the selection, textarea focused. Press `2` (cut) then `⌘↵`: a new `c5` card appears and `small` is struck through.
5. Select across the bold (`a one-line flag`) → save as fix with a note → card appears; **Copy feedback** output shows that line with `~"a one-line flag"`.
6. Hover the first paragraph → gutter `+` → save a `q` → card head shows `[paragraph "We will ship to all…"]`.
7. Select `The beta` (first occurrence) → save → **Copy feedback** shows an `<in "…[The beta] is small. The…">`-style context on that line (the quote occurs twice), while unique quotes such as `c1` have none.
8. Card **Edit** changes the note; **Resolve** dims the card and removes its highlight; **Delete** removes it.
9. **Copy feedback**: paste the clipboard into the verification notes. Expect the 4-line legend, `KEEP` before `OPEN`, OPEN in document order, `GENERAL` last, resolved items absent.
10. Click **Edit** (note editor): review mode turns off. Click **History**: review mode turns off.
11. Resize to **820** wide: Review and Copy feedback buttons are gone; page looks exactly as before this feature.
12. Open the seeded link-shared note owned by `other_user`: no Review button.

Fix anything that fails before continuing; re-run `pnpm lint && pnpm typecheck && pnpm test` after fixes.

- [ ] **Step 4: Docs**

In `CLAUDE.md`:

- Frontend file list — add:
  - `public/js/anchor.js` — pure source-quote anchoring (capture/locate); also imported by the worker (unit-tested)
  - `public/js/feedback-format.js` — pure agent-feedback text generator (unit-tested)
  - `public/js/source-lines.js` — markdown-it plugin stamping `data-line` on blocks (unit-tested)
  - `public/js/comments-ui.js` — review mode DOM: selection popover, highlights, rail, Copy feedback
- `HISTORY` storage bullet — add `comments:{uuid}` (owner's review comments `{ nextId, round, items }`, cap 500).
- API routes table — add the four comment routes from Task 3 with purposes "List review comments (owner only)", "Add comment; 409 if anchor not in current source", "Edit note/tag/status", "Delete comment".
- Testing — add: "`src/comments.integration.test.js` covers comment CRUD, ownership 404s, anchor validation, and cleanup on delete."
- Key Patterns — add: "Review comments anchor to the raw markdown (exact quote + 32-char context + 1-based line range), never to the DOM; `data-line` on rendered blocks maps selections back to source. Highlights use the CSS Custom Highlight API so the rendered DOM is never mutated. Review mode is desktop-only (≥1024px) until phase A2. Design: `docs/plans/2026-09-18-markup-comments-design.md`."

In `.claude/skills/verifier-web/SKILL.md`, add "Review me — note with seeded review comments (exact fix, keep, block question, general)" to the seed scenario list, matching the list's existing format.

- [ ] **Step 5: Commit**

```bash
git add src/seed.js src/dev.integration.test.js CLAUDE.md .claude/skills/verifier-web/SKILL.md
git commit -m "chore(comments): UAT seed scenario and docs for review comments"
```

---

## Done when

- `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` pass.
- All 12 browser checks in Task 6 pass in light and dark.
- A pasted "Copy feedback" block from the seeded note matches the spec's format rules 1–9.
- PR opened against `main` (do not deploy; CI deploys on merge).
