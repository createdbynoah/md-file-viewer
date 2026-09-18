# Markup Comments — Phase A3 Implementation Plan (auto-triage across revisions)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a new revision of a note lands, every review comment is re-checked against it: addressed comments drop out of the next export, unaddressed ones carry over, changed `keep` passages are flagged as violated, and the owner sees a round summary with a mini-diff of what replaced each addressed quote — so each feedback round is a delta on top of what was already reviewed.

**Architecture:** A pure `triage.js` (shared by browser and worker, like `anchor.js`) takes `(comments, oldSource, newSource, newRev)` and returns updated comments plus a summary. The worker runs it inside `PUT /api/files/:id`, where both sources are already in hand, wrapped so a triage failure can never fail the save. The client only renders the result: a round banner, an addressed disclosure with jsdiff mini-diffs, pinned violated keeps with "Accept change", and a ▾ menu on Copy feedback (include addressed, inline CriticMarkup).

**Tech Stack:** Vanilla ES modules (no build step), Hono worker + KV, jsdiff (already CDN-loaded as `window.Diff`), vitest 3 (node for pure modules, per-file happy-dom for DOM builders, workers pool for integration).

**Spec:** `docs/plans/2026-09-18-markup-comments-design.md` — sections "After a new revision", "Copy feedback", "Feedback format" (VIOLATED / ADDRESSED / CriticMarkup), "Triage", "API". Carry-over items: the "Carry-over to A3" section at the end of `docs/plans/2026-09-18-markup-comments-a2-plan.md`. Out of scope: tokens, `GET /feedback`, MCP (phase B).

**Branching:** create `claude/markup-comments-a3` from the head of `claude/markup-comments-agent-feedback-b75ead` (PR #82). Open the A3 PR against `main` once #82 has merged (rebase first); if #82 is still open, against that branch.

## Global Constraints

- **No fuzzy matching.** An exact anchor is "found" when `locate()` finds it (whitespace- and typographer-tolerant); otherwise it is gone. Exception, stricter: a `keep` is found only when its quote occurs **byte-identically** (`findAll`) — the legend promises the agent "keep=leave byte-identical".
- Transitions (spec table), applied only to items whose status is `open`, plus restoring a `violated` keep:

  | Tag               | Found                                  | Gone                                                       |
  | ----------------- | -------------------------------------- | ---------------------------------------------------------- |
  | `fix`, `cut`      | stays `open`, `carried++`, re-anchored | `addressed`, `resolvedRev`, `replacedBy`?, `resolvedLines` |
  | `keep`            | stays `open`, re-anchored silently     | `violated`, `replacedBy`?, `resolvedLines`                 |
  | `keep` (violated) | back to `open` (text restored)         | stays `violated`                                           |
  | `q`               | stays `open`, re-anchored              | stays `open`; anchor falls back to a line-range block      |
  | `general`         | untouched                              | —                                                          |

  Items already `addressed` are left alone apart from `rev`.

- Block anchors: found ⇔ the old block's source text (`sliceLines(old, anchor.lines)`) occurs in the new source (prefer hits at a line start, nearest to the old line). Approx anchors: found ⇔ the rendered quote ws-matches the new source after inline markers are stripped line-by-line.
- `round++` when the revision lands while at least one item is `open` or `violated`.
- `replacedBy` = the new text between the surviving 32-char `prefix` and `suffix`, only when both are found, in order, at most 2000 chars apart; `''` is a valid value (text was deleted) and is distinct from `undefined` (could not be determined).
- Every item's `rev` becomes the new revision after a successful triage. `comments.lastTriage = { rev, round, addressed, carried, violated, restored }`.
- **A triage failure never fails the PUT**: catch, log `comments.triageFailed`, leave `comments:{uuid}` untouched.
- Reopen (`PATCH status: 'open'` on an `addressed` item): keep the anchor if it locates; else re-anchor to `replacedBy` if non-empty and found; else fall back to a line-range block anchor. `violated` is never settable through PATCH; "Accept change" is `DELETE`.
- Line-range fallback block anchors use `block: { kind: 'lines', label: 'lines <s>–<e>' }` (en dash), lines clamped to the new source.
- Export rules (spec "Feedback format"): VIOLATED first; addressed never exported by default; with "include addressed" an `ADDRESSED` section is appended; addressed/violated lines print `resolvedLines` and never the "(anchor not found…)" marker. CriticMarkup export is the full source with `{==quote==}{>>id tag: note<<}`; never the default.
- All user text reaches the DOM via `textContent`. Mini-diffs are built from `diffWords` parts as `<ins>` / `<del>` elements with `textContent`.
- Owner-only 404 semantics, ids, the comment API shape and A1/A2 behavior are otherwise unchanged. `app.js` gains wiring only.
- Commit messages: conventional commits ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Gate before each commit: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`. Never deploy.

## File Structure

| File                               | Status | Responsibility                                                                 |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `public/js/comments-ui.js`         | modify | T1 composer re-presentation; T6 banner, addressed disclosure, violated, ▾ menu |
| `public/js/anchor.js`              | modify | Export `anchorAt(source, start, end)` (extracted from `captureAnchor`)         |
| `public/js/triage.js`              | new    | Pure: `triage`, `reopenAnchor`, `replacedSpan`, `stripInline`                  |
| `public/js/triage.test.js`         | new    | Unit tests                                                                     |
| `src/worker.js`                    | modify | Triage in PUT; `lastTriage` in GET; reopen re-anchoring in PATCH               |
| `src/comments.integration.test.js` | modify | Triage-on-PUT, reopen, failure isolation                                       |
| `public/js/feedback-format.js`     | modify | Resolved lines for addressed/violated; `formatCriticMarkup`                    |
| `public/js/review-layout.js`       | modify | `summarize` counts `violated`; label; `triageLabel(lastTriage)`                |
| `public/js/comments-cards.js`      | modify | Violated/addressed presentation, `buildMiniDiff`, Accept change                |
| `public/index.html`, `style.css`   | modify | Banner host, ▾ button + menu, styles                                           |
| `public/js/app.js`                 | modify | `comments.load()` after a saved edit; pass `diffWords`, menu refs              |
| `src/seed.js`                      | modify | Two-revision "Review round 2" scenario produced by calling `triage()`          |
| `CLAUDE.md`, verifier-web SKILL.md | modify | Docs                                                                           |

---

### Task 1: Carry-over bug — re-present the composer when the layout kind changes

**Files:** Modify `public/js/comments-ui.js` (`openComposer`, `closeFloating`, `onResize`, `onNoteClick`).

**Interfaces:** no public change. Internal: `composerView = { composer, title, quoted }` while a composer is open; `presentComposer(view, rect?)`.

Background (from the A2 carry-over): `onResize` keeps an open composer across a breakpoint but leaves it in its old presentation — a popover computed for a wide layout lands off-screen after rotating to portrait, and a surviving sheet loses the tap guard.

- [ ] **Step 1: Implement**

Add next to `let composerToken = 0;`:

```js
let composerView = null; // { composer, title, quoted } while a composer is open
```

Add before `openComposer`:

```js
/** Put the composer into the current layout's container (sheet or popover). */
function presentComposer(view, rect) {
  if (layout() === 'sheet') openSheet('composer', view.title, [...view.quoted, view.composer.node]);
  else openPopover([view.composer.node], rect);
  // openSheet() starts with closeFloating(), which clears these — set them last.
  composerView = view;
  composing = true;
  view.composer.focus();
}
```

In `openComposer`, replace everything from `if (layout() === 'sheet') {` through `composer.focus();` with:

```js
const target = opts.anchor || (existing && existing.anchor) || null;
const quoted = target
  ? [
      el('p', {
        className: 'review-sheet-quote',
        textContent: target.block ? `[${target.block.label}]` : target.quote,
      }),
    ]
  : [];
presentComposer({ composer, title: isGeneral ? 'General note' : 'Comment', quoted }, opts.rect);
```

In `closeFloating`, next to `composing = false;` add:

```js
composerView = null;
```

In `onResize`, replace `if (!composing) closeFloating();` with:

```js
// Move an open composer (and its unsaved draft) into the new layout's
// container; the same DOM node is re-parented, so nothing typed is lost.
const view = composerView;
closeFloating();
if (view) presentComposer(view);
```

and update the comment above it to match. (`openPopover` with no rect already falls back to the list button / rail position.)

In `onNoteClick`, change the guard `if (composing && layout() === 'sheet') return;` to key on the presentation, not the layout:

```js
if (composing && sheetKind === 'composer') return;
```

- [ ] **Step 2: Gate + browser check**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`

Follow `.claude/skills/verifier-web/SKILL.md` (`pnpm uat`), note "Review me", review mode on:

1. 820 wide: open a composer popover (select text), type `DRAFT`, resize to 375 → a `.review-sheet[data-kind="composer"]` exists, its textarea value is `DRAFT`, no `.comment-popover` remains, `getBoundingClientRect()` of the sheet is inside the viewport.
2. From there resize back to 820 → popover again with `DRAFT`, inside the viewport; clicking in the note closes it (A1 behavior).
3. 375: composer sheet with a draft, tap a highlight in the note → composer still open with the draft.
4. 1280: desktop composer unchanged (opens at the selection, Esc closes).

`pnpm uat:stop`.

- [ ] **Step 3: Commit**

```bash
git add public/js/comments-ui.js
git commit -m "fix(frontend): re-present an open composer when the layout kind changes"
```

---

### Task 2: `triage.js`

**Files:**

- Modify: `public/js/anchor.js` (export `anchorAt`; `captureAnchor` uses it)
- Create: `public/js/triage.js`
- Test: `public/js/triage.test.js`, one case added to `public/js/anchor.test.js`

**Interfaces:**

- Consumes from `anchor.js`: `locate`, `findAll`, `sliceLines`, `lineAt`, `wsRegex`, `blockAnchor`, `CONTEXT_LEN`.
- Produces:
  - `anchorAt(source, start, end): Anchor` (in `anchor.js`) — exact anchor for the substring `[start, end)` with fresh prefix/suffix/lines
  - `stripInline(text): string` — removes inline markdown markers, never newlines
  - `replacedSpan(newSource, anchor): { text: string, lines: [number, number] } | null`
  - `triage(comments, oldSource, newSource, newRev): { comments, summary }` — pure; returns new objects; `summary = { rev, round, addressed, carried, violated, restored }`
  - `reopenAnchor(source, item): Anchor`

- [ ] **Step 1: `anchorAt` — failing test, then extract**

Append to `public/js/anchor.test.js` (add `anchorAt` to the import list):

```js
describe('anchorAt', () => {
  it('builds an exact anchor with fresh context and lines', () => {
    const src = 'one\ntwo three four\nfive';
    const start = src.indexOf('three');
    const a = anchorAt(src, start, start + 5);
    expect(a).toEqual({
      quote: 'three',
      approx: false,
      prefix: 'one\ntwo ',
      suffix: ' four\nfive',
      lines: [2, 2],
    });
  });
});
```

Run: `pnpm vitest run --project unit public/js/anchor.test.js` → FAIL (`anchorAt` is not exported).

In `public/js/anchor.js` add, above `captureAnchor`:

```js
/**
 * Exact anchor for the source substring [start, end).
 * @returns {Anchor}
 */
export function anchorAt(source, start, end) {
  return {
    quote: source.slice(start, end),
    approx: false,
    prefix: source.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: source.slice(end, end + CONTEXT_LEN),
    lines: [lineAt(source, start), lineAt(source, end - 1)],
  };
}
```

and replace the tail of `captureAnchor` (from `const start = slice.offset + m.index;` to its closing `};`) with:

```js
const start = slice.offset + m.index;
return anchorAt(source, start, start + m[0].length);
```

Run the anchor tests again → PASS (all existing tests too).

- [ ] **Step 2: Write the failing triage tests**

```js
// public/js/triage.test.js
import { describe, it, expect } from 'vitest';
import { captureAnchor, blockAnchor } from './anchor.js';
import { triage, reopenAnchor, replacedSpan, stripInline } from './triage.js';

const V1 = [
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
  '', // 11
  'Latency target: p95 under 200 ms. We launch soon.', // 12
].join('\n');

const item = (id, tag, anchor, over = {}) => ({
  id,
  tag,
  note: 'n',
  anchor,
  rev: 0,
  status: 'open',
  carried: 0,
  authorId: 'u',
  createdAt: 't',
  ...over,
});
const exact = (lines, text) => captureAnchor(V1, lines, text);
const base = (items) => ({ nextId: 20, round: 1, items });
const byId = (result, id) => result.comments.items.find((i) => i.id === id);

describe('triage — exact anchors', () => {
  it('addresses a fix whose quote changed and captures what replaced it', () => {
    const c = base([item('c1', 'fix', exact([3, 3], 'all customers in a single release'))]);
    const v2 = V1.replace('all customers in a single release', 'customers in three stages');
    const r = triage(c, V1, v2, 1);
    expect(byId(r, 'c1')).toMatchObject({
      status: 'addressed',
      resolvedRev: 1,
      replacedBy: 'customers in three stages',
      resolvedLines: [3, 3],
      rev: 1,
    });
    expect(r.summary).toEqual({
      rev: 1,
      round: 2,
      addressed: 1,
      carried: 0,
      violated: 0,
      restored: 0,
    });
    expect(r.comments.round).toBe(2);
    expect(r.comments.lastTriage).toEqual(r.summary);
    expect(c.items[0].status).toBe('open'); // input untouched
  });

  it('carries an unchanged fix and follows it to its new lines', () => {
    const c = base([item('c2', 'fix', exact([12, 12], 'soon'))]);
    const r = triage(c, V1, 'Intro line.\n\n' + V1, 1);
    expect(byId(r, 'c2')).toMatchObject({ status: 'open', carried: 1, rev: 1 });
    expect(byId(r, 'c2').anchor.lines).toEqual([14, 14]);
    expect(byId(r, 'c2').anchor.prefix.endsWith('We launch ')).toBe(true);
    expect(r.summary).toMatchObject({ carried: 1, addressed: 0, round: 2 });
  });

  it('a deleted cut is addressed with an empty replacement', () => {
    const c = base([item('c3', 'cut', exact([12, 12], ' We launch soon.'), { note: '' })]);
    const r = triage(c, V1, V1.replace(' We launch soon.', ''), 1);
    expect(byId(r, 'c3')).toMatchObject({ status: 'addressed', replacedBy: '' });
  });

  it('leaves replacedBy undefined when the surrounding context is gone too', () => {
    const c = base([item('c4', 'fix', exact([12, 12], 'soon'))]);
    const r = triage(c, V1, V1.replace(/Latency target.*$/, 'Rewritten entirely.'), 1);
    expect(byId(r, 'c4').status).toBe('addressed');
    expect(byId(r, 'c4').replacedBy).toBeUndefined();
    expect(byId(r, 'c4').resolvedLines).toEqual([12, 12]);
  });
});

describe('triage — keep', () => {
  const keep = () => item('k5', 'keep', exact([12, 12], 'p95 under 200 ms'), { note: '' });
  it('re-anchors silently when untouched, without carrying', () => {
    const r = triage(base([keep()]), V1, 'x\n' + V1, 1);
    expect(byId(r, 'k5')).toMatchObject({ status: 'open', carried: 0 });
    expect(byId(r, 'k5').anchor.lines).toEqual([13, 13]);
    expect(r.summary.violated).toBe(0);
  });
  it('is violated by any change, including whitespace-only', () => {
    const changed = triage(base([keep()]), V1, V1.replace('200 ms', '250 ms'), 1);
    expect(byId(changed, 'k5')).toMatchObject({
      status: 'violated',
      replacedBy: 'p95 under 250 ms',
    });
    expect(changed.summary.violated).toBe(1);
    const reflowed = triage(base([keep()]), V1, V1.replace('p95 under', 'p95  under'), 1);
    expect(byId(reflowed, 'k5').status).toBe('violated');
  });
  it('is restored to open when the kept text comes back', () => {
    const v2 = V1.replace('200 ms', '250 ms');
    const first = triage(base([keep()]), V1, v2, 1);
    const second = triage(first.comments, v2, V1, 2);
    expect(byId(second, 'k5')).toMatchObject({ status: 'open', rev: 2 });
    expect(byId(second, 'k5').replacedBy).toBeUndefined();
    expect(second.summary).toMatchObject({ restored: 1, violated: 0, round: 3 });
  });
});

describe('triage — q, general, addressed, block, approx', () => {
  it('q stays open; when its quote is gone it falls back to a line-range block', () => {
    const c = base([item('c6', 'q', exact([12, 12], 'soon'))]);
    const r = triage(c, V1, V1.replace('soon', 'on 1 March'), 1);
    expect(byId(r, 'c6')).toMatchObject({ status: 'open', carried: 0 });
    expect(byId(r, 'c6').anchor.block).toEqual({ kind: 'lines', label: 'lines 12–12' });
  });
  it('general and already-addressed items only get the new rev; no round bump without open work', () => {
    const c = base([
      { id: 'c7', tag: 'general', note: 'Tone', rev: 0, status: 'addressed', carried: 0 },
      item('c8', 'fix', exact([12, 12], 'soon'), { status: 'addressed', resolvedRev: 0 }),
    ]);
    const r = triage(c, V1, V1 + '\nmore', 1);
    expect(byId(r, 'c7').rev).toBe(1);
    expect(byId(r, 'c8')).toMatchObject({ status: 'addressed', resolvedRev: 0, carried: 0 });
    expect(r.comments.round).toBe(1);
  });
  it('a block anchor follows its block, and is addressed when the block text changes', () => {
    const table = item('c9', 'fix', blockAnchor([8, 10], 'table', 'table under "Costs"'));
    const moved = triage(base([table]), V1, 'x\ny\n' + V1, 1);
    expect(byId(moved, 'c9')).toMatchObject({ status: 'open', carried: 1 });
    expect(byId(moved, 'c9').anchor.lines).toEqual([10, 12]);
    const edited = triage(base([table]), V1, V1.replace('| Workers | $5 |', '| Workers | $6 |'), 1);
    expect(byId(edited, 'c9')).toMatchObject({ status: 'addressed', resolvedLines: [8, 10] });
  });
  it('an approx anchor is found through inline markers, and gone when the words change', () => {
    const approx = item('c10', 'fix', captureAnchor(V1, [4, 4], 'a one-line flag'));
    expect(approx.anchor.approx).toBe(true);
    const kept = triage(base([approx]), V1, 'x\n' + V1, 1);
    expect(byId(kept, 'c10')).toMatchObject({ status: 'open', carried: 1 });
    expect(byId(kept, 'c10').anchor.lines).toEqual([5, 5]);
    const gone = triage(base([approx]), V1, V1.replace('**one-line** flag', 'single config'), 1);
    expect(byId(gone, 'c10').status).toBe('addressed');
  });
});

describe('helpers', () => {
  it('stripInline removes emphasis, code ticks and link syntax but never newlines', () => {
    expect(stripInline('a **b** _c_ `d` [e](http://x) ~~f~~\n![g](h.png)')).toBe('a b c d e f\ng');
  });
  it('replacedSpan needs prefix then suffix within reach', () => {
    const a = exact([12, 12], 'soon');
    expect(replacedSpan(V1.replace('soon', 'on 1 March'), a)).toEqual({
      text: 'on 1 March',
      lines: [12, 12],
    });
    expect(replacedSpan('nothing alike', a)).toBeNull();
  });
  it('reopenAnchor prefers the live anchor, then the replacement, then a line block', () => {
    const live = item('c1', 'fix', exact([12, 12], 'soon'), { status: 'addressed' });
    expect(reopenAnchor(V1, live)).toEqual(live.anchor);
    const v2 = V1.replace('soon', 'on 1 March');
    const replaced = { ...live, replacedBy: 'on 1 March', resolvedLines: [12, 12] };
    expect(reopenAnchor(v2, replaced)).toMatchObject({
      quote: 'on 1 March',
      approx: false,
      lines: [12, 12],
    });
    const lost = { ...live, replacedBy: undefined, resolvedLines: [40, 41] };
    expect(reopenAnchor('only\ntwo lines', lost)).toMatchObject({
      lines: [2, 2],
      block: { kind: 'lines', label: 'lines 2–2' },
    });
  });
});
```

Run: `pnpm vitest run --project unit public/js/triage.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement**

```js
// public/js/triage.js
// Re-checks every review comment against a new revision. Pure and shared: the
// worker runs it inside PUT /api/files/:id, the UAT seed uses it to build a
// round-2 scenario, and the tests drive it directly.
import { anchorAt, blockAnchor, findAll, lineAt, locate, sliceLines, wsRegex } from './anchor.js';

const MAX_REPLACED = 2000;

/** Drop inline markdown markers so a rendered quote can be matched. Never touches newlines. */
export function stripInline(text) {
  return text.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1').replace(/(\*\*|__|~~|\*|_|`)/g, '');
}

const lineCount = (source) => lineAt(source, source.length);

function clampLines(source, [s, e]) {
  const max = lineCount(source);
  const start = Math.min(Math.max(s, 1), max);
  return [start, Math.min(Math.max(e, start), max)];
}

function linesBlock(source, lines) {
  const [s, e] = clampLines(source, lines);
  return blockAnchor([s, e], 'lines', `lines ${s}–${e}`);
}

function nearest(source, offsets, line) {
  let best = null;
  for (const at of offsets) {
    const dist = Math.abs(lineAt(source, at) - line);
    if (!best || dist < best.dist) best = { at, dist };
  }
  return best ? best.at : -1;
}

/** The new text sitting between an anchor's surviving prefix and suffix, or null. */
export function replacedSpan(newSource, anchor) {
  if (!anchor.prefix && !anchor.suffix) return null;
  const from = anchor.prefix
    ? nearest(newSource, findAll(newSource, anchor.prefix), anchor.lines[0])
    : 0;
  if (from === -1) return null;
  const start = from + anchor.prefix.length;
  const end = anchor.suffix ? newSource.indexOf(anchor.suffix, start) : newSource.length;
  if (end === -1 || end - start > MAX_REPLACED) return null;
  return {
    text: newSource.slice(start, end),
    lines: [lineAt(newSource, start), lineAt(newSource, Math.max(start, end - 1))],
  };
}

/** Where an anchor sits in the new source: { anchor } when found, else null. */
function follow(oldSource, newSource, item) {
  const a = item.anchor;
  if (a.block) {
    const text = sliceLines(oldSource, a.lines).text;
    const hits = findAll(newSource, text);
    const atLineStart = hits.filter((i) => i === 0 || newSource[i - 1] === '\n');
    const at = nearest(newSource, atLineStart.length ? atLineStart : hits, a.lines[0]);
    if (at === -1) return null;
    const first = lineAt(newSource, at);
    return { anchor: { ...a, lines: [first, first + (a.lines[1] - a.lines[0])] } };
  }
  if (a.approx) {
    const stripped = stripInline(newSource);
    const hits = [...stripped.matchAll(wsRegex(a.quote))];
    if (!hits.length) return null;
    const m = hits.find(
      (h) =>
        h.index ===
        nearest(
          stripped,
          hits.map((h2) => h2.index),
          a.lines[0]
        )
    );
    return {
      anchor: {
        ...a,
        lines: [lineAt(stripped, m.index), lineAt(stripped, m.index + m[0].length - 1)],
      },
    };
  }
  // keep promises the agent "byte-identical": whitespace or typographic
  // equivalence is good enough to carry a fix, not to honor a keep.
  if (item.tag === 'keep' && !findAll(newSource, a.quote).length) return null;
  const hit = locate(newSource, a);
  return hit ? { anchor: anchorAt(newSource, hit.start, hit.end) } : null;
}

function withoutResolution(item) {
  const { replacedBy: _r, resolvedLines: _l, resolvedRev: _v, ...rest } = item;
  return rest;
}

/**
 * @param {{ nextId: number, round: number, items: any[] }} comments
 * @param {string} oldSource the revision the anchors were last resolved against
 * @param {string} newSource the revision that just landed
 * @param {number} newRev
 */
export function triage(comments, oldSource, newSource, newRev) {
  const summary = {
    rev: newRev,
    round: comments.round,
    addressed: 0,
    carried: 0,
    violated: 0,
    restored: 0,
  };
  const hadWork = comments.items.some((i) => i.status === 'open' || i.status === 'violated');

  const items = comments.items.map((item) => {
    if (!item.anchor || item.status === 'addressed') return { ...item, rev: newRev };
    const found = follow(oldSource, newSource, item);

    if (found) {
      if (item.status === 'violated') {
        summary.restored++;
        return { ...withoutResolution(item), anchor: found.anchor, status: 'open', rev: newRev };
      }
      const carries = item.tag === 'fix' || item.tag === 'cut';
      if (carries) summary.carried++;
      return {
        ...item,
        anchor: found.anchor,
        carried: item.carried + (carries ? 1 : 0),
        rev: newRev,
      };
    }

    if (item.status === 'violated') {
      summary.violated++;
      return { ...item, rev: newRev };
    }
    if (item.tag === 'q') {
      return { ...item, anchor: linesBlock(newSource, item.anchor.lines), rev: newRev };
    }
    const span =
      item.anchor.block || item.anchor.approx ? null : replacedSpan(newSource, item.anchor);
    const resolved = {
      ...item,
      rev: newRev,
      resolvedRev: newRev,
      resolvedLines: span ? span.lines : clampLines(newSource, item.anchor.lines),
      ...(span ? { replacedBy: span.text } : {}),
    };
    if (item.tag === 'keep') {
      summary.violated++;
      return { ...resolved, status: 'violated' };
    }
    summary.addressed++;
    return { ...resolved, status: 'addressed' };
  });

  summary.round = comments.round + (hadWork ? 1 : 0);
  return { comments: { ...comments, round: summary.round, items, lastTriage: summary }, summary };
}

/** Anchor to use when an addressed comment is reopened against `source`. */
export function reopenAnchor(source, item) {
  if (locate(source, item.anchor)) return item.anchor;
  if (item.replacedBy) {
    const at = nearest(
      source,
      findAll(source, item.replacedBy),
      (item.resolvedLines || item.anchor.lines)[0]
    );
    if (at !== -1) return anchorAt(source, at, at + item.replacedBy.length);
  }
  return linesBlock(source, item.resolvedLines || item.anchor.lines);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run --project unit public/js/triage.test.js public/js/anchor.test.js`
Expected: PASS (14 triage tests + the anchor suite). If a test and the implementation disagree, work out which is wrong against the Global Constraints table — do not weaken a test silently.

- [ ] **Step 5: Commit**

```bash
git add public/js/anchor.js public/js/anchor.test.js public/js/triage.js public/js/triage.test.js
git commit -m "feat(comments): pure triage of review comments across revisions"
```

---

### Task 3: Worker — triage on PUT, `lastTriage` on GET, reopen re-anchoring

**Files:** Modify `src/worker.js`; Test `src/comments.integration.test.js`.

**Interfaces:**

- Consumes: `triage`, `reopenAnchor` from `../public/js/triage.js`; `anchorAt` from `../public/js/anchor.js`.
- `POST …/comments` now rebuilds an exact anchor server-side with `anchorAt(source, hit.start, hit.end)` — quote, prefix, suffix and lines become authoritative instead of trusting the client's context (triage's `replacedBy` depends on a correct prefix/suffix).
- Produces:
  - `PUT /api/files/:id` response gains `triage: summary | null` (null when there are no comments or triage failed)
  - `GET /api/files/:id/comments` → `{ round, items, lastTriage }` (`lastTriage` may be `undefined`)
  - `PATCH …/:cid` with `status: 'open'` on an `addressed` item re-anchors via `reopenAnchor`, clears `replacedBy` / `resolvedLines` / `resolvedRev`, sets `rev = meta.currentRev`; PATCH on a `violated` item may change `note` only — a `status` in the body → 400

- [ ] **Step 1: Write the failing tests**

Append inside `describe('comments', …)` in `src/comments.integration.test.js`:

```js
const put = (noteId, content) =>
  authed(`/api/files/${noteId}`, json({ content }, { method: 'PUT' }));
const list = async (noteId) => (await authed(`/api/files/${noteId}/comments`)).json();

it('triages comments when a revision lands', async () => {
  await post(id, { tag: 'fix', note: 'Give a date', anchor: quoteAnchor('soon', 3) });
  await post(id, { tag: 'keep', anchor: quoteAnchor('Rollback is one flag.', 4) });
  await post(id, { tag: 'fix', note: 'Which customers?', anchor: quoteAnchor('all customers', 3) });
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
```

Run: `pnpm vitest run --project integration src/comments.integration.test.js` → the five new tests FAIL.

- [ ] **Step 2: Implement**

Import at the top of `src/worker.js`:

```js
import { triage, reopenAnchor } from '../public/js/triage.js';
```

`readComments` currently swallows a missing key into an empty value. Add beside it a reader that distinguishes "none":

```js
/** Raw comments value, or null when the note has none (or the value is unreadable). */
async function readCommentsOrNull(kv, id) {
  const raw = await kv.get(commentsKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
```

(`commentsKey`, `readComments` are defined below the PUT handler today; `const` arrow/function order does not matter at request time, but move `commentsKey` and these two readers up beside `revKey` so PUT does not reference a `const` declared later in the module.)

In the POST comments handler, replace `anchor.lines = hit.lines;` with:

```js
// Context drives triage later (replacedBy is found between prefix and suffix),
// so never trust the client's copy of it.
anchor =
  hit.start == null ? { ...anchor, lines: hit.lines } : anchorAt(sourceText, hit.start, hit.end);
```

where `sourceText` is the note text already read for `locate` (hoist it: `const sourceText = await obj.text();` then `locate(sourceText, anchor)`; `anchor` is already declared with `let`). Block and approx anchors (`hit.start == null`) keep their client fields and only get the resolved lines. Add `anchorAt` to the existing `anchor.js` import. Add one assertion to the existing "creates comments…" integration test: `expect(item.anchor.prefix).toBe('# Plan\n\nShip to all customers ');` (the client sent an empty prefix).

In the PUT handler, after `await c.env.HISTORY.put(\`meta:${id}\`, JSON.stringify(meta));`and before the`log.info('file.edit', …)` line:

```js
// Re-check review comments against the new revision. The save has already
// succeeded; nothing here may turn it into an error.
let triageSummary = null;
try {
  const comments = await readCommentsOrNull(c.env.HISTORY, id);
  if (comments && comments.items.length) {
    const result = triage(comments, current, content, n);
    await c.env.HISTORY.put(commentsKey(id), JSON.stringify(result.comments));
    triageSummary = result.summary;
  }
} catch (err) {
  log.error('comments.triageFailed', { fileId: id, rev: n, error: String(err) });
}
```

and change the response to:

```js
return c.json({ id, currentRev: n, revision, triage: triageSummary });
```

In `GET /api/files/:id/comments`, return `lastTriage` too:

```js
const { round, items, lastTriage } = await readComments(c.env.HISTORY, c.req.param('id'));
return c.json({ round, items, lastTriage });
```

In the PATCH handler, `ownedMeta(c)` must keep its result (`const meta = await ownedMeta(c); if (!meta) …`). Replace the `if (body.status !== undefined) { … }` block with:

```js
if (body.status !== undefined) {
  if (item.status === 'violated' || !COMMENT_STATUSES.includes(body.status)) {
    return c.json({ error: 'Invalid status' }, 400);
  }
  if (item.status === 'addressed' && body.status === 'open' && item.anchor) {
    const obj = await c.env.MD_FILES.get(`${id}.md`);
    if (!obj) return c.json({ error: 'File not found' }, 404);
    item.anchor = reopenAnchor(await obj.text(), item);
    delete item.replacedBy;
    delete item.resolvedLines;
    delete item.resolvedRev;
    item.rev = meta.currentRev || 0;
  }
  item.status = body.status;
}
```

- [ ] **Step 3: Run to verify pass**

Run: `pnpm vitest run --project integration src/comments.integration.test.js && pnpm typecheck`
Expected: PASS. (`triage.js` is now type-checked transitively; fix JSDoc there if `tsc` complains — e.g. the unused destructured names in `withoutResolution` may need an eslint/tsc-friendly form.)

- [ ] **Step 4: Commit**

```bash
git add src/worker.js src/comments.integration.test.js
git commit -m "feat(api): triage review comments when a revision lands; reopen re-anchors"
```

---

### Task 4: Export — resolved lines, ADDRESSED section, CriticMarkup

**Files:** Modify `public/js/feedback-format.js`; Test `public/js/feedback-format.test.js`.

**Interfaces:**

- `formatFeedback` (unchanged signature): for `addressed` and `violated` items print `item.resolvedLines` (fallback `anchor.lines`), never the "(anchor not found…)" marker; an addressed line ends with ` (addressed in rev <resolvedRev>)`.
- New: `formatCriticMarkup(comments, source): string`.

- [ ] **Step 1: Write the failing tests**

Append to `public/js/feedback-format.test.js` (add `formatCriticMarkup` to the import):

```js
describe('triaged items', () => {
  const gone = { quote: 'gone text', approx: false, prefix: '', suffix: '', lines: [1, 1] };
  it('prints resolved lines for violated and addressed items, without the not-found marker', () => {
    const out = fmt(
      [
        item({ id: 'k2', tag: 'keep', status: 'violated', anchor: gone, resolvedLines: [2, 2] }),
        item({
          id: 'c3',
          status: 'addressed',
          anchor: gone,
          resolvedLines: [3, 3],
          resolvedRev: 4,
        }),
      ],
      { includeAddressed: true }
    );
    expect(out).toContain('VIOLATED — kept text was changed; restore it\nk2 L2 "gone text"');
    expect(out).toContain('ADDRESSED\nc3 fix L3 "gone text" (addressed in rev 4)');
    expect(out).not.toContain('anchor not found');
  });
});

describe('formatCriticMarkup', () => {
  it('wraps located quotes and notes blocks and general inline, leaving the rest byte-identical', () => {
    const out = formatCriticMarkup(
      {
        round: 1,
        items: [
          item({ id: 'c1', note: 'Give a date' }),
          item({
            id: 'c2',
            tag: 'q',
            note: 'Why?',
            anchor: {
              quote: '',
              approx: false,
              prefix: '',
              suffix: '',
              lines: [2, 2],
              block: { kind: 'paragraph', label: 'paragraph "Median latency"' },
            },
          }),
          { id: 'c3', tag: 'general', note: 'Too salesy', status: 'open' },
          item({ id: 'c4', status: 'addressed' }),
        ],
      },
      SRC
    );
    expect(out).toBe(
      '{>>general: Too salesy<<}\n' +
        'Tail latency matters.\n' +
        '{>>c2 q [paragraph "Median latency"]: Why?<<}Median latency does not.\n' +
        'Ship {==soon==}{>>c1 fix: Give a date<<}.'
    );
  });
  it('carries a literal replacement and keeps notes on one line', () => {
    const out = formatCriticMarkup(
      { round: 1, items: [item({ id: 'c1', note: 'a\nb', replace: 'on 1 March' })] },
      SRC
    );
    expect(out).toContain('{==soon==}{>>c1 fix => "on 1 March": a b<<}');
  });
});
```

Run: `pnpm vitest run --project unit public/js/feedback-format.test.js` → FAIL.

- [ ] **Step 2: Implement**

In `itemLines`, replace the `const at = …` line and the two trailing `head +=` conditionals so resolved items use their resolved position:

```js
const resolved = item.status === 'addressed' || item.status === 'violated';
const at = resolved ? item.resolvedLines || item.anchor.lines : hit ? hit.lines : item.anchor.lines;
```

```js
if (item.status === 'addressed' && item.resolvedRev != null) {
  head += ` (addressed in rev ${item.resolvedRev})`;
}
if (!hit && !resolved) head += ' (anchor not found in current source)';
```

and make `lineOf` in `formatFeedback` agree:

```js
const lineOf = (i) =>
  (i.status === 'addressed' || i.status === 'violated'
    ? i.resolvedLines || i.anchor.lines
    : (hits.get(i) || i.anchor).lines)[0];
```

Append the new export:

```js
/**
 * The full source with open comments embedded as CriticMarkup, for an agent
 * that has no copy of the document. Costs the whole document in tokens.
 */
export function formatCriticMarkup(comments, source) {
  const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
  const open = comments.items.filter((i) => i.status === 'open');
  const inserts = []; // { at, text }, applied from the end so offsets stay valid
  const lineStart = (line) => {
    let at = 0;
    for (let n = 1; n < line; n++) at = source.indexOf('\n', at) + 1;
    return at;
  };
  for (const item of open) {
    if (!item.anchor) continue;
    const hit = locate(source, item.anchor);
    if (!hit) continue;
    const label = `${item.id} ${item.tag}${item.replace ? ` => "${esc(item.replace)}"` : ''}`;
    const note = item.note ? `: ${oneLine(item.note)}` : '';
    if (hit.start == null) {
      const what = item.anchor.block
        ? ` [${item.anchor.block.label}]`
        : ` ~"${oneLine(item.anchor.quote)}"`;
      inserts.push({ at: lineStart(hit.lines[0]), text: `{>>${label}${what}${note}<<}` });
    } else {
      inserts.push({ at: hit.end, text: `==}{>>${label}${note}<<}` });
      inserts.push({ at: hit.start, text: '{==' });
    }
  }
  let out = source;
  for (const ins of inserts.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  }
  const general = open.filter((i) => i.tag === 'general' && i.note);
  const head = general.map((g) => `{>>general: ${oneLine(g.note)}<<}\n`).join('');
  return head + out;
}
```

- [ ] **Step 3: Run to verify pass, commit**

Run: `pnpm vitest run --project unit public/js/feedback-format.test.js` → PASS.

```bash
git add public/js/feedback-format.js public/js/feedback-format.test.js
git commit -m "feat(comments): export resolved lines for triaged items; CriticMarkup export"
```

---

### Task 5: Summary counts and card presentation for triaged items

**Files:** Modify `public/js/review-layout.js`, `public/js/comments-cards.js`; Tests beside them.

**Interfaces:**

- `summarize(items)` → `{ open, keep, addressed, violated }`; `summaryLabel` leads with `N violated` when non-zero.
- New `triageLabel(lastTriage): string` → `"Round 2: 4 addressed · 1 carried over · 1 keep violated"` (zero parts omitted; `restored` shown as `N keep restored`; all zero → `"Round 2: nothing changed for your comments"`).
- `buildMiniDiff(oldText, newText, diffWords): HTMLElement` — `div.comment-diff` of `<del>`/`<ins>`/text nodes via `textContent`; `diffWords(a, b)` returns jsdiff parts `{ value, added?, removed? }`.
- `buildCard(item, opts)` — `opts` gains optional `diffWords` and `onAccept`. Violated: class `is-violated`, head reads `k2 · keep · violated · "…"`, single action **Accept change** (`onAccept`). Addressed: actions **Reopen**, **Delete**. Both show the mini-diff when `item.replacedBy !== undefined`, the anchor has a quote, and `diffWords` was given.

- [ ] **Step 1: Write the failing tests**

In `public/js/review-layout.test.js` replace the two `summarize / summaryLabel` expectations that mention counts and add (import `triageLabel`):

```js
it('counts violated keeps on their own and leads the label with them', () => {
  expect(summarize(items)).toEqual({ open: 3, keep: 1, addressed: 1, violated: 1 });
  expect(summaryLabel({ open: 3, keep: 1, addressed: 1, violated: 1 })).toBe(
    '1 violated · 3 open · 1 keep'
  );
  expect(summaryLabel({ open: 3, keep: 1, addressed: 1, violated: 0 })).toBe('3 open · 1 keep');
});

describe('triageLabel', () => {
  it('summarizes a round and omits zero parts', () => {
    expect(
      triageLabel({ rev: 3, round: 2, addressed: 4, carried: 1, violated: 1, restored: 0 })
    ).toBe('Round 2: 4 addressed · 1 carried over · 1 keep violated');
    expect(
      triageLabel({ rev: 3, round: 3, addressed: 0, carried: 0, violated: 0, restored: 1 })
    ).toBe('Round 3: 1 keep restored');
    expect(
      triageLabel({ rev: 3, round: 2, addressed: 0, carried: 0, violated: 0, restored: 0 })
    ).toBe('Round 2: nothing changed for your comments');
  });
});
```

(Update the existing `summarize` test's expected object to include `violated: 1`, and the existing `summaryLabel` calls to pass `violated: 0`.)

Append to `public/js/comments-cards.test.js` (import `buildMiniDiff`):

```js
const fakeDiff = (a, b) => [
  { value: 'ship ' },
  { value: a.replace('ship ', ''), removed: true },
  { value: b.replace('ship ', ''), added: true },
];

describe('triaged cards', () => {
  it('buildMiniDiff renders parts as del/ins text, never markup', () => {
    const d = buildMiniDiff('ship soon', 'ship <b>1 March</b>', fakeDiff);
    expect(d.className).toBe('comment-diff');
    expect(d.querySelector('del').textContent).toBe('soon');
    expect(d.querySelector('ins').textContent).toBe('<b>1 March</b>');
    expect(d.querySelector('b')).toBeNull();
  });
  it('an addressed card shows the mini-diff and offers Reopen and Delete only', () => {
    const card = buildCard(item({ status: 'addressed', replacedBy: 'on 1 March' }), {
      orphaned: false,
      active: false,
      diffWords: fakeDiff,
      ...handlers(),
    });
    expect(card.querySelector('.comment-diff')).not.toBeNull();
    expect(
      [...card.querySelectorAll('.comment-card-actions button')].map((b) => b.textContent)
    ).toEqual(['Reopen', 'Delete']);
  });
  it('a violated keep is marked, never "anchor not found", and offers Accept change', () => {
    const onAccept = vi.fn();
    const card = buildCard(item({ id: 'k2', tag: 'keep', status: 'violated', replacedBy: 'x' }), {
      orphaned: true,
      active: false,
      diffWords: fakeDiff,
      onAccept,
      ...handlers(),
    });
    expect(card.classList.contains('is-violated')).toBe(true);
    expect(card.querySelector('.comment-card-head').textContent).toBe(
      'k2 · keep · violated · "soon"'
    );
    const buttons = card.querySelectorAll('.comment-card-actions button');
    expect([...buttons].map((b) => b.textContent)).toEqual(['Accept change']);
    buttons[0].click();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
  it('no mini-diff when the replacement is unknown or there is no quote', () => {
    const card = buildCard(item({ status: 'addressed' }), {
      orphaned: false,
      active: false,
      diffWords: fakeDiff,
      ...handlers(),
    });
    expect(card.querySelector('.comment-diff')).toBeNull();
  });
});
```

Run both files → FAIL.

- [ ] **Step 2: Implement**

`public/js/review-layout.js` — replace `summarize` and `summaryLabel`, add `triageLabel`:

```js
export function summarize(items) {
  const out = { open: 0, keep: 0, addressed: 0, violated: 0 };
  for (const item of items) {
    if (item.status === 'addressed') out.addressed++;
    else if (item.status === 'violated') out.violated++;
    else if (item.status === 'open') out[item.tag === 'keep' ? 'keep' : 'open']++;
  }
  return out;
}

export function summaryLabel({ open, keep, addressed, violated = 0 }) {
  const parts = [];
  if (violated) parts.push(`${violated} violated`);
  if (open) parts.push(`${open} open`);
  if (keep) parts.push(`${keep} keep`);
  if (parts.length) return parts.join(' · ');
  return addressed ? 'All addressed' : 'No comments yet';
}

/** Banner text for the last triage, e.g. "Round 2: 4 addressed · 1 carried over". */
export function triageLabel({ round, addressed, carried, violated, restored }) {
  const parts = [];
  if (addressed) parts.push(`${addressed} addressed`);
  if (carried) parts.push(`${carried} carried over`);
  if (violated) parts.push(`${violated} keep violated`);
  if (restored) parts.push(`${restored} keep restored`);
  return `Round ${round}: ${parts.length ? parts.join(' · ') : 'nothing changed for your comments'}`;
}
```

`public/js/comments-cards.js` — add `buildMiniDiff`, and in `buildCard` take the new options and branch on status:

```js
/** Word diff of what replaced a quote, as <del>/<ins> text. */
export function buildMiniDiff(oldText, newText, diffWords) {
  const box = el('div', { className: 'comment-diff' });
  for (const part of diffWords(oldText, newText)) {
    box.append(el(part.added ? 'ins' : part.removed ? 'del' : 'span', { textContent: part.value }));
  }
  return box;
}
```

In `buildCard`'s options destructuring add `diffWords, onAccept`. Replace the head text and the actions block:

```js
const violated = item.status === 'violated';
const marker = violated ? ' · violated' : orphaned ? ' · anchor not found' : '';
```

(use `${item.id} · ${item.tag}${marker} · ${cardQuote(item)}` for the head; add `card.classList.toggle('is-violated', violated);`)

After the note lines:

```js
if (diffWords && item.replacedBy !== undefined && item.anchor.quote) {
  card.append(buildMiniDiff(item.anchor.quote, item.replacedBy, diffWords));
}
```

Actions:

```js
const actions = violated
  ? [action('Accept change', onAccept)]
  : item.status === 'addressed'
    ? [action('Reopen', onToggle), action('Delete', onDelete, true)]
    : [action('Edit', onEdit), action('Resolve', onToggle), action('Delete', onDelete, true)];
card.append(el('div', { className: 'comment-card-actions' }, actions));
```

Update the existing test "an addressed card offers Reopen" to read the first action button (index 0).

- [ ] **Step 3: Run to verify pass, commit**

Run: `pnpm vitest run --project unit public/js/review-layout.test.js public/js/comments-cards.test.js` → PASS.

```bash
git add public/js/review-layout.js public/js/review-layout.test.js public/js/comments-cards.js public/js/comments-cards.test.js
git commit -m "feat(comments): violated/addressed cards with mini-diff; round summary labels"
```

---

### Task 6: Review UI — round banner, addressed disclosure, violated keeps, ▾ export menu

**Files:** Modify `public/js/comments-ui.js`, `public/index.html`, `public/css/style.css`, `public/js/app.js`.

**Interfaces:**

- Consumes: `triageLabel` (T5), `buildCard` opts `diffWords`/`onAccept` (T5), `formatCriticMarkup` (T4), `GET /comments` `lastTriage` (T3).
- `initComments` deps gain: `banner: HTMLElement` (`#review-banner`), `copyMenuBtn: HTMLButtonElement` (`#copy-feedback-menu-btn`), `copyMenu: HTMLElement` (`#copy-feedback-menu`), `diffWords: (a, b) => parts[]`.

- [ ] **Step 1: Markup**

`public/index.html` — directly after the `#copy-feedback-btn` button:

```html
<span class="copy-feedback-more">
  <button
    id="copy-feedback-menu-btn"
    class="text-btn"
    aria-label="More copy options"
    aria-haspopup="menu"
    aria-expanded="false"
    hidden
  >
    ▾
  </button>
  <div id="copy-feedback-menu" class="folder-dropdown" role="menu" hidden></div>
</span>
```

Directly **before** `<article id="rendered-output" …>`:

```html
<div id="review-banner" class="review-banner" role="status" hidden></div>
```

- [ ] **Step 2: Styles** — append to `public/css/style.css`:

```css
/* ── Review comments: triage (phase A3) ──────────────────────────────────── */

.review-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px max(24px, calc((100% - 860px) / 2)) 0;
  padding: 8px 12px;
  font-size: 0.8125rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
}
.review-banner[hidden] {
  display: none;
}
.review-banner.has-violations {
  border-color: var(--danger);
}
.review-banner-text {
  margin-right: auto;
}

.comment-card.is-violated {
  border-color: var(--danger);
  border-left: 3px solid var(--danger);
}
.comment-card.is-violated .comment-card-actions {
  display: flex;
}
.comment-diff {
  margin-top: 4px;
  font-size: 0.75rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.comment-diff del {
  background: var(--review-cut);
}
.comment-diff ins {
  background: var(--review-keep);
  text-decoration: none;
}

.comments-addressed {
  margin-top: 8px;
  font-size: 0.8125rem;
}
.comments-addressed > summary {
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px 0;
}
.comments-addressed .comment-card {
  position: static;
  margin-top: 8px;
}
.comments-addressed .comment-card-actions {
  display: flex;
}

.copy-feedback-more {
  position: relative;
}
@media (max-width: 767px) {
  .copy-feedback-more {
    display: none;
  }
}
.review-sheet-copy {
  display: flex;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--border-light);
}
```

- [ ] **Step 3: Controller changes in `comments-ui.js`**

Imports: add `formatCriticMarkup` to the `feedback-format.js` import and `triageLabel` to the `review-layout.js` import.

Destructure the new deps at the top of `initComments`: `banner, copyMenuBtn, copyMenu`. Add state: `let addressedOpen = false;`.

`cardFor` — pass the new options:

```js
diffWords: deps.diffWords,
onAccept: () => remove(item.id),
```

Add a shared list builder and use it from both `renderRail` and `renderFlatList` so ordering rules live in one place:

```js
/** Violated keeps first, then live items by position; addressed go to the disclosure. */
function partition() {
  const anchored = data.items.filter((i) => i.anchor);
  return {
    violated: anchored.filter((i) => i.status === 'violated'),
    live: anchored.filter((i) => i.status === 'open'),
    addressed: anchored.filter((i) => i.status === 'addressed'),
  };
}

function addressedDisclosure(addressed) {
  const details = el('details', { className: 'comments-addressed', open: addressedOpen }, [
    el('summary', { textContent: `${addressed.length} addressed` }),
    ...addressed.map((item) => cardFor(item, false, false)),
  ]);
  details.addEventListener('toggle', () => {
    // Creating it with `open` set fires a toggle too; only a real change may
    // re-render, or the rebuild below would loop.
    if (details.open === addressedOpen) return;
    addressedOpen = details.open;
    if (layout() === 'rail') renderList(); // re-measure: the rail's height is explicit
  });
  return details;
}
```

`renderRail` — replace its body with:

```js
const { violated, live, addressed } = partition();
const general = data.items.find((i) => i.tag === 'general');
const generalCard = buildGeneralCard(general, () => openComposer({ general }));
rail.append(generalCard);
let floor = generalCard.offsetTop + generalCard.offsetHeight + CARD_GAP;
const place = (card, top) => {
  rail.append(card);
  const y = Math.max(top ?? floor, floor);
  card.style.top = `${y}px`;
  floor = y + card.offsetHeight + CARD_GAP;
};
// Violated keeps are pinned under the general note, not at their (gone) anchor.
for (const item of violated) place(cardFor(item, false), null);
const placed = live
  .map((item) => ({ item, top: targetTop(item), orphaned: !targets.has(item.id) }))
  .sort((a, b) => (a.top ?? Infinity) - (b.top ?? Infinity));
for (const { item, top, orphaned } of placed) place(cardFor(item, orphaned), top);
if (addressed.length) {
  const details = addressedDisclosure(addressed);
  details.style.position = 'absolute';
  details.style.left = '0';
  details.style.right = '0';
  details.style.top = `${floor}px`;
  rail.append(details);
  floor += details.offsetHeight + CARD_GAP;
}
rail.style.height = `${floor}px`;
```

`renderFlatList(host)` — replace its body with:

```js
const { violated, live, addressed } = partition();
const general = data.items.find((i) => i.tag === 'general');
host.append(buildGeneralCard(general, () => openComposer({ general })));
for (const item of violated) host.append(cardFor(item, false));
const line = (item) => targets.get(item.id)?.lines[0] ?? Infinity;
for (const item of [...live].sort((a, b) => line(a) - line(b))) {
  host.append(cardFor(item, !targets.has(item.id)));
}
if (addressed.length) host.append(addressedDisclosure(addressed));
if (host === sheetBody) {
  const more = (label, fn) => {
    const b = el('button', { type: 'button', className: 'text-btn', textContent: label });
    b.addEventListener('click', () => fn(b));
    return b;
  };
  host.append(
    el('div', { className: 'review-sheet-copy' }, [
      more('Copy incl. addressed', (b) => copyFeedback(b, 'addressed')),
      more('Copy inline (CriticMarkup)', (b) => copyFeedback(b, 'critic')),
    ])
  );
}
```

Banner — add and call from `repaint()` (after `renderBar();`):

```js
function renderBanner() {
  const current = note();
  const t = data.lastTriage;
  const seenKey = current && t ? `triageSeen:${current.id}:${t.rev}` : null;
  let seen = false;
  try {
    seen = Boolean(seenKey && localStorage.getItem(seenKey));
  } catch {}
  const unverified = Boolean(
    current && data.items.some((i) => i.anchor && (i.rev ?? 0) < (current.currentRev || 0))
  );
  const showRound = Boolean(t && current && t.rev === current.currentRev && !seen);
  banner.replaceChildren();
  banner.hidden = !(active() && (showRound || unverified));
  if (banner.hidden) return;
  banner.classList.toggle('has-violations', Boolean(showRound && t.violated));
  banner.append(
    el('span', {
      className: 'review-banner-text',
      textContent: showRound
        ? triageLabel(t)
        : 'Comments were not re-checked against this revision; positions may be stale.',
    })
  );
  if (showRound) {
    const dismiss = el('button', { type: 'button', className: 'text-btn', textContent: 'Dismiss' });
    dismiss.addEventListener('click', () => {
      try {
        localStorage.setItem(seenKey, '1');
      } catch {}
      renderBanner();
    });
    banner.append(dismiss);
  }
}
```

`load()` — the GET now returns `lastTriage`; `data = await res.json()` already keeps it. Reset `addressedOpen = false;` there.

Copy variants — replace `copyFeedback` with:

```js
/** mode: undefined (open only) | 'addressed' | 'critic' */
function copyFeedback(flashOn, mode) {
  const current = note();
  if (!current) return;
  const source = deps.getSource();
  const text =
    mode === 'critic'
      ? formatCriticMarkup(data, source)
      : formatFeedback(
          data,
          source,
          { title: deps.getTitle(), rev: current.currentRev },
          { includeAddressed: mode === 'addressed' }
        );
  navigator.clipboard
    .writeText(text)
    .then(() => deps.flashCopied(flashOn))
    .catch(() => {});
}
```

▾ menu — in `repaint()` set `copyMenuBtn.hidden = copyBtn.hidden;` right after `copyBtn.hidden = …`. Register once at init, next to the `copyBtn` listener:

```js
function closeCopyMenu() {
  copyMenu.hidden = true;
  copyMenuBtn.setAttribute('aria-expanded', 'false');
}
copyMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!copyMenu.hidden) return closeCopyMenu();
  copyMenu.replaceChildren(
    ...[
      ['Open only', undefined],
      ['Include addressed', 'addressed'],
      ['Inline (CriticMarkup)', 'critic'],
    ].map(([label, mode]) => {
      const b = el('button', {
        type: 'button',
        className: 'folder-dropdown-item',
        textContent: label,
      });
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeCopyMenu();
        copyFeedback(copyBtn, mode);
      });
      return b;
    })
  );
  copyMenu.hidden = false;
  copyMenuBtn.setAttribute('aria-expanded', 'true');
});
document.addEventListener('click', closeCopyMenu);
```

Also call `closeCopyMenu()` inside `setReviewMode` when turning off, and add `copyMenuBtn`, `copyMenu`, `banner` to the `isChrome` list.

- [ ] **Step 4: Wire `app.js`**

Refs next to `copyFeedbackBtn`:

```js
const copyFeedbackMenuBtn = document.getElementById('copy-feedback-menu-btn');
const copyFeedbackMenu = document.getElementById('copy-feedback-menu');
const reviewBanner = document.getElementById('review-banner');
```

Add to the `initComments({ … })` call:

```js
banner: reviewBanner,
copyMenuBtn: copyFeedbackMenuBtn,
copyMenu: copyFeedbackMenu,
diffWords: (a, b) => window.Diff.diffWords(a, b),
```

In `saveEdit`, directly after `exitEditMode();`:

```js
// The save re-triaged the review comments server-side; fetch the result.
comments.load();
```

In `headerLocked()`, add `!copyFeedbackMenu.hidden ||` to the chain (an open menu keeps the header shown, like the other menus).

- [ ] **Step 5: Gate + smoke**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`

`pnpm uat`, "Review me" at 1280, review on: add a fix on `soon`… (the seeded note has no `soon`; use any phrase), Edit the note to change that phrase, Save → banner shows `Round 2: 1 addressed · …`, the card moved under "1 addressed" with a del/ins mini-diff, highlights for it are gone; Dismiss hides the banner and it stays hidden after reload. ▾ → "Include addressed" copies text containing `ADDRESSED`. No console errors. `pnpm uat:stop`. Deep verification is Task 7.

- [ ] **Step 6: Commit**

```bash
git add public/js/comments-ui.js public/index.html public/css/style.css public/js/app.js
git commit -m "feat(frontend): round banner, addressed mini-diffs, violated keeps, Copy feedback menu"
```

---

### Task 7: Seed scenario, browser verification, docs

**Files:** Modify `src/seed.js`, `src/dev.integration.test.js` (only if it asserts a seeded-note count), `CLAUDE.md`, `.claude/skills/verifier-web/SKILL.md`.

- [ ] **Step 1: Seed a triaged, two-revision note by calling `triage()`**

In `src/seed.js`: import `import { triage } from '../public/js/triage.js';` and `import { captureAnchor, blockAnchor } from '../public/js/anchor.js';`. Add `round2: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'` to `SEED_IDS`. Mirror the existing "Code blocks" revisions pattern (`meta.currentRev`, `rev:{id}` log, `{id}/r/{n}.md` snapshots):

```js
const ROUND_V1 = [
  '# Launch brief', // 1
  '', // 2
  'We will ship to all customers in a single release.', // 3
  'Latency target: p95 under 200 ms.', // 4
  'Rollback is a one-line flag flip.', // 5
  '', // 6
  'The beta ends soon.', // 7
  '',
].join('\n');
const ROUND_V2 = ROUND_V1.replace(
  'all customers in a single release',
  'customers in three stages'
).replace('200 ms', '250 ms');

const roundItem = (id, tag, note, anchor) => ({
  id,
  tag,
  note,
  anchor,
  rev: 0,
  status: 'open',
  carried: 0,
  authorId: OWNER,
  createdAt: ago(1),
});
const ROUND_COMMENTS = triage(
  {
    nextId: 5,
    round: 1,
    items: [
      roundItem(
        'c1',
        'fix',
        'Stage it',
        captureAnchor(ROUND_V1, [3, 3], 'all customers in a single release')
      ),
      roundItem('k2', 'keep', '', captureAnchor(ROUND_V1, [4, 4], 'p95 under 200 ms')),
      roundItem('c3', 'fix', 'Give a date', captureAnchor(ROUND_V1, [7, 7], 'soon')),
      roundItem(
        'k4',
        'keep',
        '',
        captureAnchor(ROUND_V1, [5, 5], 'Rollback is a one-line flag flip.')
      ),
    ],
  },
  ROUND_V1,
  ROUND_V2,
  1
).comments;
```

Add `note(SEED_IDS.round2, 'Review round 2', ROUND_V2, { createdDays: 1 })` to `notes`; after notes are written set its `meta.currentRev = 1` the same way the `code` note does, write `rev:{id}` (rev 1 "Agent revision", rev 0 "Original"), snapshots `r/0.md` = `ROUND_V1` and `r/1.md` = `ROUND_V2`, and `comments:{id}` = `ROUND_COMMENTS`. Expected state: `c1` addressed with `replacedBy`, `k2` violated, `c3` open carried 1, `k4` open; `lastTriage = { rev: 1, round: 2, addressed: 1, carried: 1, violated: 1, restored: 0 }`.

Run `pnpm test`; bump the seeded-note count in `src/dev.integration.test.js` if it asserts one.

- [ ] **Step 2: Verify in a real browser** (`verifier-web` skill; `pnpm uat`; `pnpm uat:stop` at the end). Record PASS/FAIL with DOM/state evidence.

On **"Review round 2"**, 1280×800, light then dark:

1. Review on → banner `Round 2: 1 addressed · 1 carried over · 1 keep violated` with the danger border; rail order: General, **k2 (violated, danger styling, mini-diff `200`→`250`, only "Accept change")**, then `k4`/`c3` at their anchors; "1 addressed" disclosure at the bottom, collapsed.
2. Highlights: `soon` (fix) and the Rollback sentence (keep) are painted; nothing is painted for `c1` or `k2`.
3. Expand "1 addressed" → `c1` card with del `all customers in a single release` / ins `customers in three stages`, actions Reopen + Delete. Rail height grows to contain it (no overlap with the page footer/next content).
4. **Copy feedback** (default) → clipboard has `round 2`, a `VIOLATED` section with `k2 L4 "p95 under 200 ms"`, `KEEP` with `k4`, `OPEN` with `c3 fix L7 "soon" (carried: unchanged since round 1)`, and **no** `c1`. ▾ → "Include addressed" adds `ADDRESSED` + `c1 … (addressed in rev 1)`. ▾ → "Inline (CriticMarkup)" → full source containing `{==soon==}{>>c3 fix: Give a date<<}` and no markup for `c1`/`k2`.
5. Reopen `c1` → it becomes an open card anchored on `customers in three stages` (highlight painted there); the disclosure disappears.
6. Accept change on `k2` → card gone; banner text unchanged until the next triage; Copy feedback has no `VIOLATED` section.
7. Dismiss the banner → hidden; reload → still hidden (`localStorage` key `triageSeen:<id>:1`).
8. Full loop: Edit the note, change `soon` to `on 1 March`, restore `250 ms` to `200 ms`… (k2 was deleted in check 6 — re-seed first via `/api/dev/seed` and do this check on a fresh seed instead): Edit → replace `250 ms` with `200 ms` and `soon` with `on 1 March` → Save → banner `Round 3: 1 addressed · 1 keep restored`; `k2` is a normal keep again with its highlight; `c3` is under addressed.
9. Whitespace-only change inside a keep (re-seed; Edit `Rollback is a one-line` → `Rollback is a  one-line`, two spaces) → `k4` becomes violated.
10. Triage-failure isolation is covered by the integration test; in the browser just confirm a save on a note with **no** comments shows no banner.

At **375 (mobile preset)**, on a fresh seed:

11. Bar summary reads `1 violated · 1 open · 1 keep`; the banner shows above the note and wraps without overflow; list sheet: violated first, "1 addressed" disclosure expands inside the sheet's scroll, and the two extra copy buttons at the bottom copy the addressed / CriticMarkup variants.
12. Item sheet for `c3` (tap its highlight) still works; "Accept change" on `k2` works from the list sheet.

At **820**: 13. Drawer shows the same order; ▾ menu opens under the toolbar button, header stays pinned while it is open.

Task 1 regression: 14. repeat Task 1's checks 1–3 once.

Fix anything that fails (minimal change, right file), re-run the gate, re-verify, commit each fix separately.

- [ ] **Step 3: Docs**

`CLAUDE.md`: frontend file list — add `public/js/triage.js` (pure; imported by the worker and the UAT seed; unit-tested). API table — PUT row: "Edit content; creates a revision and re-triages review comments (owner only)"; note `lastTriage` on the comments GET and that reopening re-anchors. Storage bullet — `comments:{uuid}` value is `{ nextId, round, items, lastTriage }`. Key Patterns — add: "Triage (`public/js/triage.js`) runs inside `PUT /api/files/:id` with old and new source in hand, wrapped in try/catch — a triage failure must never fail a save. No fuzzy matching: `fix`/`cut` found (whitespace/typographer-tolerant) → carried, gone → `addressed` with `replacedBy` captured between the surviving 32-char context; `keep` must be byte-identical or it becomes `violated` (restored automatically if the text comes back); `q`/`general` are manual. The client only renders the result (banner dismissed per `triageSeen:{id}:{rev}` in `localStorage`)." Remove the carry-over items this plan closed from the A2 plan's carry-over section (the composer re-presentation bug; "approx/block anchors' exported `L` numbers do not follow line shifts").

`.claude/skills/verifier-web/SKILL.md`: add the "Review round 2" scenario (two revisions; `c1` addressed with replacement, `k2` violated, `c3` carried, `k4` kept).

- [ ] **Step 4: Gate and commit**

```bash
git add src/seed.js src/dev.integration.test.js CLAUDE.md .claude/skills/verifier-web/SKILL.md docs/plans/2026-09-18-markup-comments-a2-plan.md
git commit -m "chore(comments): round-2 UAT seed via triage(); docs for triage"
```

---

## Done when

- `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` pass.
- All 14 browser checks pass (1–9 in light and dark).
- A feedback block copied after a revision contains only VIOLATED / KEEP / still-open items — the delta — and its `L` numbers match the new revision.
- PR opened per the Branching note (do not deploy; CI deploys on merge).
