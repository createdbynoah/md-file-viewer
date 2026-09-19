# Markup Comments — Phase A2 Implementation Plan (tablet + mobile)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review mode works at every viewport: a list drawer and tap-to-open popovers on tablet (768–1023px), and on phones (<768px) a floating "Comment" pill, a bottom-sheet composer that rides above the keyboard, and a bottom review bar with counts, the comment list, and Copy feedback.

**Architecture:** `comments-ui.js` stays the controller (state, API, anchoring, highlights) but its DOM builders move out — `comments-composer.js` (the form) and `comments-cards.js` (a comment card) — so one composer/card can be _presented_ in a popover, the rail, a drawer, or a bottom sheet. Layout decisions and keyboard-inset maths live in a pure `review-layout.js`. Input mode is chosen by pointer type (coarse → pill, fine → mouseup popover); presentation by width (rail ≥1024, drawer 768–1023, sheet <768).

**Tech Stack:** Vanilla ES modules (no build step), CSS Custom Highlight API, `visualViewport`, `matchMedia('(pointer: coarse)')`, vitest 3 (node env for pure modules, `happy-dom` per-file env for the two DOM builders), Hono worker.

**Spec:** `docs/plans/2026-09-18-markup-comments-design.md` — sections "Creating a comment" (Mobile, Block comment) and "Reading comments" (768–1023px and <768px rows). A1 plan for background: `docs/plans/2026-09-18-markup-comments-a1-plan.md`. Out of scope here: triage, round banner, mini-diff, violated keeps, the Copy-feedback ▾ menu, CriticMarkup (A3); tokens/endpoint/MCP (B).

**Branching:** A1 is PR #82 (`claude/markup-comments-agent-feedback-b75ead`). Create `claude/markup-comments-a2` from A1's head. Open the A2 PR against `main` once #82 has merged (rebase first); if #82 is still open, open it against the A1 branch.

## Global Constraints

- Breakpoints are exactly: rail `>= 1024`, drawer `768–1023`, sheet `<= 767` (the app's existing mobile breakpoint is 768).
- Input mode: `(pointer: coarse)` **or** sheet layout → selection shows a floating pill and never auto-opens the composer; otherwise (fine pointer, ≥768) → A1's mouseup popover.
- Never fight the native selection UI: no `contextmenu`/`selectstart` prevention, no custom handles. The pill must not clear the selection when tapped (`pointerdown` → `preventDefault()`), and the anchor is captured when the selection changes, not when the pill is tapped.
- iOS 26 rule (CLAUDE.md): no `background` directly on sticky/fixed chrome — the sheet, bar and pill paint their background with `::before`.
- The document stays the only vertical scroller. Sheets are `position: fixed` with their own `max-height` + inner scroll; no `overflow` on the app shell. While the review bar is shown the note gets bottom padding so its last lines are reachable.
- The sheet sits above the on-screen keyboard: `bottom: var(--kb-inset)`, where `--kb-inset` = `innerHeight - visualViewport.height - visualViewport.offsetTop`, clamped at 0, updated on `visualViewport` `resize` and `scroll`.
- Review mode is **not** exited when the viewport crosses a breakpoint (rotation); floating UI is closed and everything repaints in the new layout.
- All user text reaches the DOM through `textContent`. No `innerHTML` with comment data.
- A1 behavior at ≥1024px with a mouse must be unchanged, except: the composer gains visible **Save** / **Cancel** buttons.
- Owner-only semantics, ids, anchors, the feedback format, and the API are unchanged. The only server change is rejecting a whitespace-only quote.
- `app.js` gains wiring only.
- Commit messages: conventional commits ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Gate before each commit: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`. Never deploy.

## File Structure

| File                                  | Status | Responsibility                                                                        |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `public/js/anchor.js`                 | modify | Memoize the line-start table per source (perf item parked at the end of A1)           |
| `src/worker.js`                       | modify | `cleanAnchor` rejects whitespace-only quotes                                          |
| `public/js/review-layout.js`          | new    | Pure: `layoutFor`, `keyboardInset`, `summarize`, `summaryLabel`                       |
| `public/js/review-layout.test.js`     | new    | Unit tests (node)                                                                     |
| `public/js/el.js`                     | new    | The tiny `el()` DOM helper, shared                                                    |
| `public/js/comments-composer.js`      | new    | `buildComposer()` — the comment form, presentation-agnostic                           |
| `public/js/comments-composer.test.js` | new    | Unit tests (happy-dom)                                                                |
| `public/js/comments-cards.js`         | new    | `buildCard()`, `buildGeneralCard()`                                                   |
| `public/js/comments-cards.test.js`    | new    | Unit tests (happy-dom)                                                                |
| `public/js/comments-ui.js`            | modify | Controller: uses the builders; adds drawer, sheet, pill, review bar, layout switching |
| `public/index.html`                   | modify | `#comments-list-btn`, `#comments-drawer`; `data-secondary` on `#review-btn`           |
| `public/css/style.css`                | modify | Replace the A1 "<1024 hidden" block with drawer/sheet/pill/bar styles                 |
| `public/js/app.js`                    | modify | Pass `drawer` and `listBtn` to `initComments`                                         |
| `CLAUDE.md`, verifier-web `SKILL.md`  | modify | Docs                                                                                  |

---

### Task 1: Parked A1 items — `locate()` line-table memo, whitespace-quote guard

**Files:**

- Modify: `public/js/anchor.js` (`lineStarts` / `locate`, ~lines 25–41 and 148–153)
- Modify: `src/worker.js` (`cleanAnchor`)
- Test: `public/js/anchor.test.js`, `src/comments.integration.test.js`

**Interfaces:**

- Consumes: existing `locate(source, anchor)`.
- Produces: no signature changes. `locate` reuses the line-start table while it is called repeatedly with the same `source` string (every repaint and every `formatFeedback` does exactly that).

- [ ] **Step 1: Write the failing tests**

Append to `public/js/anchor.test.js`:

```js
describe('locate performance', () => {
  it('does not rescan a large source for every anchor', () => {
    const big = Array.from(
      { length: 40000 },
      (_, i) => `line ${i} of a fairly long document body`
    ).join('\n'); // ~1.7 MB
    const anchors = Array.from({ length: 500 }, (_, i) =>
      blockAnchor([i + 1, i + 2], 'paragraph', `paragraph ${i}`)
    );
    const t0 = performance.now();
    for (const a of anchors) expect(locate(big, a)).not.toBeNull();
    expect(performance.now() - t0).toBeLessThan(400);
  });
  it('still sees a changed source (memo is per source string)', () => {
    const a = captureAnchor('one\ntwo\nthree', [2, 2], 'two');
    expect(locate('one\ntwo\nthree', a).lines).toEqual([2, 2]);
    expect(locate('zero\none\ntwo\nthree', a).lines).toEqual([3, 3]);
    expect(locate('one\nthree', blockAnchor([3, 3], 'paragraph', 'x'))).toBeNull();
  });
});
```

Append inside the `describe('comments', …)` block of `src/comments.integration.test.js`:

```js
it('rejects a whitespace-only quote', async () => {
  const res = await post(id, { tag: 'cut', anchor: quoteAnchor('   ', 3) });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit public/js/anchor.test.js`
Expected: the performance test FAILS (takes seconds — 500 full scans). The memo test passes already; it guards the change.

Run: `pnpm vitest run --project integration src/comments.integration.test.js`
Expected: the new test FAILS with 201 or 409 instead of 400.

- [ ] **Step 3: Implement**

In `public/js/anchor.js`, directly after the `lineStarts` function add:

```js
// locate() runs once per comment against the same source on every repaint and
// every export; build the line table once per source string, not once per call.
let startsMemo = { source: null, starts: null };
function lineStartsFor(source) {
  if (startsMemo.source !== source) startsMemo = { source, starts: lineStarts(source) };
  return startsMemo.starts;
}
```

In `locate`, change `const starts = lineStarts(source);` to:

```js
const starts = lineStartsFor(source);
```

In `src/worker.js` `cleanAnchor`, change the final `else if (!anchor.quote) {` to:

```js
} else if (!anchor.quote.trim()) {
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run --project unit public/js/anchor.test.js && pnpm vitest run --project integration src/comments.integration.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/js/anchor.js public/js/anchor.test.js src/worker.js src/comments.integration.test.js
git commit -m "perf(anchor): memoize line table per source; reject whitespace-only quotes"
```

---

### Task 2: `review-layout.js`

**Files:**

- Create: `public/js/review-layout.js`
- Test: `public/js/review-layout.test.js`

**Interfaces:**

- Produces:
  - `layoutFor(width: number): 'rail' | 'drawer' | 'sheet'`
  - `keyboardInset({ innerHeight, vvHeight, vvOffsetTop }): number` — px the on-screen keyboard covers at the bottom, ≥ 0, rounded
  - `summarize(items): { open: number, keep: number, addressed: number }` — `open` counts status-open non-keep items (general included); `keep` counts status-open keeps
  - `summaryLabel(summary): string`

- [ ] **Step 1: Write the failing tests**

```js
// public/js/review-layout.test.js
import { describe, it, expect } from 'vitest';
import { layoutFor, keyboardInset, summarize, summaryLabel } from './review-layout.js';

describe('layoutFor', () => {
  it('uses the app breakpoints', () => {
    expect(layoutFor(1440)).toBe('rail');
    expect(layoutFor(1024)).toBe('rail');
    expect(layoutFor(1023)).toBe('drawer');
    expect(layoutFor(768)).toBe('drawer');
    expect(layoutFor(767)).toBe('sheet');
    expect(layoutFor(375)).toBe('sheet');
  });
});

describe('keyboardInset', () => {
  it('is zero with no keyboard', () => {
    expect(keyboardInset({ innerHeight: 800, vvHeight: 800, vvOffsetTop: 0 })).toBe(0);
  });
  it('is the covered height when the keyboard is up', () => {
    expect(keyboardInset({ innerHeight: 800, vvHeight: 460.4, vvOffsetTop: 0 })).toBe(340);
  });
  it('accounts for the visual viewport being scrolled within the layout viewport', () => {
    expect(keyboardInset({ innerHeight: 800, vvHeight: 460, vvOffsetTop: 100 })).toBe(240);
  });
  it('never goes negative (pinch zoom, overscroll)', () => {
    expect(keyboardInset({ innerHeight: 800, vvHeight: 820, vvOffsetTop: 0 })).toBe(0);
  });
});

describe('summarize / summaryLabel', () => {
  const items = [
    { tag: 'fix', status: 'open' },
    { tag: 'q', status: 'open' },
    { tag: 'general', status: 'open' },
    { tag: 'keep', status: 'open' },
    { tag: 'cut', status: 'addressed' },
    { tag: 'keep', status: 'violated' },
  ];
  it('counts open work, keeps and addressed separately', () => {
    expect(summarize(items)).toEqual({ open: 3, keep: 1, addressed: 1 });
  });
  it('labels compactly and omits zero parts', () => {
    expect(summaryLabel({ open: 3, keep: 1, addressed: 1 })).toBe('3 open · 1 keep');
    expect(summaryLabel({ open: 0, keep: 2, addressed: 0 })).toBe('2 keep');
    expect(summaryLabel({ open: 0, keep: 0, addressed: 4 })).toBe('All addressed');
    expect(summaryLabel({ open: 0, keep: 0, addressed: 0 })).toBe('No comments yet');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project unit public/js/review-layout.test.js`
Expected: FAIL — cannot resolve `./review-layout.js`.

- [ ] **Step 3: Implement**

```js
// public/js/review-layout.js
// Pure layout decisions for review mode, kept out of comments-ui.js so they can
// be unit-tested: which presentation a viewport gets, how far the on-screen
// keyboard pushes the bottom sheet up, and the review bar's summary text.

export const RAIL_MIN_WIDTH = 1024;
export const DRAWER_MIN_WIDTH = 768;

/** rail: margin cards · drawer: list in the sticky header · sheet: bottom sheets. */
export function layoutFor(width) {
  if (width >= RAIL_MIN_WIDTH) return 'rail';
  return width >= DRAWER_MIN_WIDTH ? 'drawer' : 'sheet';
}

/** Pixels of the layout viewport's bottom covered by the on-screen keyboard. */
export function keyboardInset({ innerHeight, vvHeight, vvOffsetTop }) {
  return Math.max(0, Math.round(innerHeight - vvHeight - vvOffsetTop));
}

export function summarize(items) {
  const out = { open: 0, keep: 0, addressed: 0 };
  for (const item of items) {
    if (item.status === 'addressed') out.addressed++;
    else if (item.status === 'open') out[item.tag === 'keep' ? 'keep' : 'open']++;
  }
  return out;
}

export function summaryLabel({ open, keep, addressed }) {
  const parts = [];
  if (open) parts.push(`${open} open`);
  if (keep) parts.push(`${keep} keep`);
  if (parts.length) return parts.join(' · ');
  return addressed ? 'All addressed' : 'No comments yet';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run --project unit public/js/review-layout.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add public/js/review-layout.js public/js/review-layout.test.js
git commit -m "feat(comments): pure review layout and keyboard-inset helpers"
```

---

### Task 3: Extract the composer and card builders (no behavior change)

**Files:**

- Create: `public/js/el.js`, `public/js/comments-composer.js`, `public/js/comments-cards.js`
- Test: `public/js/comments-composer.test.js`, `public/js/comments-cards.test.js`
- Modify: `package.json` (devDependency `happy-dom`), `public/js/comments-ui.js`, `public/css/style.css`

**Interfaces:**

- Produces:
  - `el(tag, props?, children?)` from `./el.js` (moved verbatim from `comments-ui.js`)
  - `TAGS`, `NOTE_OPTIONAL`, `buildComposer({ existing?, isGeneral?, anchor?, onSubmit, onCancel }) → { node: HTMLElement, focus(): void }` — `onSubmit({ body: { note, replace }, tag, tagLocked })` may be async and may throw an `Error` whose message is shown inline; `onCancel()` fires on Escape and on the Cancel button
  - `cardQuote(item): string`, `buildCard(item, { orphaned, active, onActivate, onEdit, onToggle, onDelete }) → HTMLElement`, `buildGeneralCard(general | undefined, onOpen) → HTMLElement`
- Consumes: nothing new.

- [ ] **Step 1: Add the test-only DOM environment**

Run: `pnpm add -D happy-dom`

- [ ] **Step 2: Write the failing tests**

```js
// public/js/comments-composer.test.js
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { buildComposer } from './comments-composer.js';

const quote = { quote: 'soon', approx: false, prefix: '', suffix: '', lines: [3, 3] };
const block = { ...quote, quote: '', block: { kind: 'table', label: 'table' } };
const q = (node, sel) => node.querySelector(sel);
const pressed = (node) => q(node, '.comment-tags [aria-pressed="true"]').textContent;

describe('buildComposer', () => {
  it('defaults to fix, shows Replace only for quoted fix comments', () => {
    const { node } = buildComposer({ anchor: quote, onSubmit: vi.fn(), onCancel: vi.fn() });
    expect(pressed(node)).toBe('1 fix');
    expect(q(node, 'input').hidden).toBe(false);
    q(node, '.comment-tags button:nth-child(2)').click();
    expect(pressed(node)).toBe('2 cut');
    expect(q(node, 'input').hidden).toBe(true);
    const blockComposer = buildComposer({ anchor: block, onSubmit: vi.fn(), onCancel: vi.fn() });
    expect(q(blockComposer.node, 'input').hidden).toBe(true);
  });

  it('requires a note for fix, not for cut', async () => {
    const onSubmit = vi.fn();
    const { node } = buildComposer({ anchor: quote, onSubmit, onCancel: vi.fn() });
    q(node, '.comment-save').click();
    await Promise.resolve();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(q(node, '.comment-error').textContent).toBe('Add a note first');
    q(node, '.comment-tags button:nth-child(2)').click();
    q(node, '.comment-save').click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith({
      body: { note: '', replace: '' },
      tag: 'cut',
      tagLocked: false,
    });
  });

  it('submits note + replace and shows a thrown error inline', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Could not save'));
    const { node } = buildComposer({ anchor: quote, onSubmit, onCancel: vi.fn() });
    q(node, 'textarea').value = 'Give a date';
    q(node, 'input').value = 'on 1 March';
    q(node, '.comment-save').click();
    await new Promise((r) => setTimeout(r));
    expect(onSubmit.mock.calls[0][0].body).toEqual({ note: 'Give a date', replace: 'on 1 March' });
    expect(q(node, '.comment-error').textContent).toBe('Could not save');
    expect(q(node, '.comment-save').disabled).toBe(false);
  });

  it('Alt+digit picks a tag by physical key; bare digits do not', () => {
    const { node } = buildComposer({ anchor: quote, onSubmit: vi.fn(), onCancel: vi.fn() });
    node.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', key: '3', bubbles: true }));
    expect(pressed(node)).toBe('1 fix');
    node.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Digit3', key: '£', altKey: true, bubbles: true })
    );
    expect(pressed(node)).toBe('3 q');
  });

  it('locks the tag for keep and general, and prefills when editing', () => {
    const keep = { id: 'k2', tag: 'keep', note: 'Approved', anchor: quote };
    const { node } = buildComposer({ existing: keep, onSubmit: vi.fn(), onCancel: vi.fn() });
    expect(q(node, '.comment-tags')).toBeNull();
    expect(q(node, 'textarea').value).toBe('Approved');
    const general = buildComposer({ isGeneral: true, onSubmit: vi.fn(), onCancel: vi.fn() });
    expect(q(general.node, '.comment-tags')).toBeNull();
    expect(q(general.node, 'input').hidden).toBe(true);
  });

  it('an existing non-keep comment cannot become keep', () => {
    const fix = { id: 'c1', tag: 'fix', note: 'x', anchor: quote };
    const { node } = buildComposer({ existing: fix, onSubmit: vi.fn(), onCancel: vi.fn() });
    q(node, '.comment-tags button:nth-child(4)').click();
    expect(pressed(node)).toBe('1 fix');
  });

  it('Escape and Cancel call onCancel; Cmd+Enter submits', async () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    const { node } = buildComposer({ anchor: quote, onSubmit, onCancel });
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    q(node, '.comment-cancel').click();
    expect(onCancel).toHaveBeenCalledTimes(2);
    q(node, 'textarea').value = 'n';
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })
    );
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
```

```js
// public/js/comments-cards.test.js
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { buildCard, buildGeneralCard, cardQuote } from './comments-cards.js';

const item = (over = {}) => ({
  id: 'c1',
  tag: 'fix',
  note: '<img src=x onerror=alert(1)>',
  status: 'open',
  anchor: { quote: 'soon', approx: false, prefix: '', suffix: '', lines: [3, 3] },
  ...over,
});
const handlers = () => ({
  onActivate: vi.fn(),
  onEdit: vi.fn(),
  onToggle: vi.fn(),
  onDelete: vi.fn(),
});

describe('buildCard', () => {
  it('renders user text as text, never as markup', () => {
    const card = buildCard(item(), { orphaned: false, active: false, ...handlers() });
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.comment-card-note').textContent).toBe(
      '<img src=x onerror=alert(1)>'
    );
    expect(card.dataset.id).toBe('c1');
    expect(card.dataset.tag).toBe('fix');
  });
  it('head shows id, tag, quote, and the orphan marker', () => {
    const card = buildCard(item(), { orphaned: true, active: false, ...handlers() });
    expect(card.querySelector('.comment-card-head').textContent).toBe(
      'c1 · fix · anchor not found · "soon"'
    );
    const block = item({ anchor: { ...item().anchor, block: { kind: 'table', label: 'table' } } });
    expect(cardQuote(block)).toBe('[table]');
  });
  it('shows the replacement, and state classes', () => {
    const card = buildCard(item({ replace: 'on 1 March', status: 'addressed' }), {
      orphaned: false,
      active: true,
      ...handlers(),
    });
    expect(card.querySelectorAll('.comment-card-note')[0].textContent).toBe('→ on 1 March');
    expect(card.classList.contains('is-active')).toBe(true);
    expect(card.classList.contains('is-addressed')).toBe(true);
  });
  it('action buttons call their handler without activating the card', () => {
    const h = handlers();
    const card = buildCard(item(), { orphaned: false, active: true, ...h });
    const [edit, toggle, del] = card.querySelectorAll('.comment-card-actions button');
    expect(toggle.textContent).toBe('Resolve');
    edit.click();
    toggle.click();
    del.click();
    expect(h.onEdit).toHaveBeenCalledTimes(1);
    expect(h.onToggle).toHaveBeenCalledTimes(1);
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onActivate).not.toHaveBeenCalled();
    card.click();
    expect(h.onActivate).toHaveBeenCalledTimes(1);
  });
  it('an addressed card offers Reopen', () => {
    const card = buildCard(item({ status: 'addressed' }), {
      orphaned: false,
      active: true,
      ...handlers(),
    });
    expect(card.querySelectorAll('.comment-card-actions button')[1].textContent).toBe('Reopen');
  });
});

describe('buildGeneralCard', () => {
  it('shows the note or an invitation, and opens on click', () => {
    const onOpen = vi.fn();
    const empty = buildGeneralCard(undefined, onOpen);
    expect(empty.querySelector('.comment-card-note').textContent).toBe(
      'Add a note about the whole document'
    );
    empty.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    const filled = buildGeneralCard({ id: 'c4', tag: 'general', note: 'Too salesy' }, onOpen);
    expect(filled.querySelector('.comment-card-note').textContent).toBe('Too salesy');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run --project unit public/js/comments-composer.test.js public/js/comments-cards.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the modules**

```js
// public/js/el.js
/** createElement + props + children, for DOM built without innerHTML. */
export function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}
```

```js
// public/js/comments-composer.js
// The comment form: tag chips, note, optional literal replacement, Save/Cancel.
// Presentation-agnostic — comments-ui.js decides whether it sits in a popover
// or a bottom sheet.
import { el } from './el.js';

export const TAGS = ['fix', 'cut', 'q', 'keep'];
export const NOTE_OPTIONAL = new Set(['cut', 'keep']);

/**
 * @param {{ existing?: any, isGeneral?: boolean, anchor?: any,
 *   onSubmit: (payload: { body: { note: string, replace: string }, tag: string, tagLocked: boolean }) => any,
 *   onCancel: () => void }} opts
 * @returns {{ node: HTMLElement, focus: () => void }}
 */
export function buildComposer({
  existing = null,
  isGeneral = false,
  anchor = null,
  onSubmit,
  onCancel,
}) {
  let tag = existing ? existing.tag : isGeneral ? 'general' : 'fix';
  // keep/general ids are fixed (see the PATCH rules), so their tag cannot change.
  const tagLocked = isGeneral || Boolean(existing && existing.tag === 'keep');
  const target = anchor || (existing && existing.anchor) || null;
  const hasQuote = Boolean(target && !target.block);

  const tagRow = el('div', { className: 'comment-tags' });
  const tagButtons = TAGS.map((t, i) => {
    const b = el('button', { type: 'button', textContent: `${i + 1} ${t}` });
    b.addEventListener('click', () => setTag(t));
    tagRow.append(b);
    return b;
  });
  const noteInput = el('textarea', { rows: 2, placeholder: 'Add a note' });
  const replaceInput = el('input', { type: 'text', placeholder: 'Replace with (optional, exact)' });
  const error = el('span', { className: 'comment-error' });
  const saveBtn = el('button', {
    type: 'button',
    className: 'primary-btn comment-save',
    textContent: 'Save',
  });
  const cancelBtn = el('button', {
    type: 'button',
    className: 'text-btn comment-cancel',
    textContent: 'Cancel',
  });
  if (existing) {
    noteInput.value = existing.note || '';
    replaceInput.value = existing.replace || '';
  }

  function setTag(next) {
    if (tagLocked || (existing && next === 'keep')) return;
    tag = next;
    tagButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(TAGS[i] === tag)));
    replaceInput.hidden = !(hasQuote && tag === 'fix');
  }

  async function save() {
    const body = { note: noteInput.value, replace: replaceInput.hidden ? '' : replaceInput.value };
    if (!NOTE_OPTIONAL.has(tag) && !body.note.trim() && !body.replace.trim()) {
      error.textContent = 'Add a note first';
      return;
    }
    error.textContent = '';
    saveBtn.disabled = true;
    try {
      await onSubmit({ body, tag, tagLocked });
    } catch (e) {
      error.textContent = e.message;
    } finally {
      saveBtn.disabled = false;
    }
  }

  const node = el('div', { className: 'comment-composer' }, [
    ...(tagLocked ? [] : [tagRow]),
    noteInput,
    replaceInput,
    el('div', { className: 'comment-composer-foot' }, [
      el('span', { className: 'comment-hint', textContent: '⌥1–4 tag · ⌘↵ save · esc cancel' }),
      error,
      cancelBtn,
      saveBtn,
    ]),
  ]);
  setTag(tag);
  if (tagLocked) replaceInput.hidden = true;

  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', () => onCancel());
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') onCancel();
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
    // Alt/Option+1–4 only — bare digits must always type into the note. macOS
    // Option+digit remaps e.key, so match the physical key via e.code.
    else if (!tagLocked && e.altKey && /^Digit[1-4]$/.test(e.code)) {
      e.preventDefault();
      setTag(TAGS[Number(e.code.slice(-1)) - 1]);
    }
  });

  return { node, focus: () => noteInput.focus() };
}
```

```js
// public/js/comments-cards.js
// One review comment as a card. Used by the desktop rail, the tablet drawer,
// the mobile list sheet, and the tap-a-highlight item view.
import { el } from './el.js';

export function cardQuote(item) {
  return item.anchor.block ? `[${item.anchor.block.label}]` : `"${item.anchor.quote}"`;
}

/**
 * @param {any} item
 * @param {{ orphaned: boolean, active: boolean, onActivate: () => void,
 *   onEdit: () => void, onToggle: () => void, onDelete: () => void }} opts
 */
export function buildCard(item, { orphaned, active, onActivate, onEdit, onToggle, onDelete }) {
  const card = el('div', { className: 'comment-card' }, [
    el('div', {
      className: 'comment-card-head',
      textContent: `${item.id} · ${item.tag}${orphaned ? ' · anchor not found' : ''} · ${cardQuote(item)}`,
    }),
  ]);
  card.dataset.id = item.id;
  card.dataset.tag = item.tag;
  card.classList.toggle('is-active', active);
  card.classList.toggle('is-addressed', item.status === 'addressed');
  if (item.replace) {
    card.append(el('div', { className: 'comment-card-note', textContent: `→ ${item.replace}` }));
  }
  if (item.note) card.append(el('div', { className: 'comment-card-note', textContent: item.note }));

  const action = (label, fn, danger) => {
    const b = el('button', {
      type: 'button',
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
      action('Edit', onEdit),
      action(item.status === 'open' ? 'Resolve' : 'Reopen', onToggle),
      action('Delete', onDelete, true),
    ])
  );
  card.addEventListener('click', () => onActivate());
  return card;
}

export function buildGeneralCard(general, onOpen) {
  const card = el('div', { className: 'comment-card comments-general' }, [
    el('div', { className: 'comment-card-head', textContent: 'General note' }),
    el('div', {
      className: 'comment-card-note',
      textContent: general ? general.note : 'Add a note about the whole document',
    }),
  ]);
  card.addEventListener('click', () => onOpen());
  return card;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run --project unit public/js/comments-composer.test.js public/js/comments-cards.test.js`
Expected: PASS, 7 + 6 tests.

- [ ] **Step 6: Switch `comments-ui.js` to the builders**

In `public/js/comments-ui.js`:

1. Imports — add:

```js
import { el } from './el.js';
import { buildCard, buildGeneralCard } from './comments-cards.js';
import { buildComposer } from './comments-composer.js';
```

2. Delete the local `TAGS`, `NOTE_OPTIONAL` constants, the local `el` function, and the whole `buildCard` function.

3. In `renderRail`, replace the `generalCard` construction and its `addEventListener` with:

```js
const generalCard = buildGeneralCard(general, () => openComposer({ general }));
```

and replace `const card = buildCard(item, orphaned);` with:

```js
const card = cardFor(item, orphaned);
```

4. Add next to `renderRail`:

```js
function cardFor(item, orphaned, active = item.id === activeId) {
  return buildCard(item, {
    orphaned,
    active,
    onActivate: () => activate(item.id, { scroll: true }),
    onEdit: () => openComposer({ existing: item }),
    onToggle: () =>
      patch(item.id, { status: item.status === 'open' ? 'addressed' : 'open' }).catch(() => {}),
    onDelete: () => remove(item.id),
  });
}
```

5. Replace the entire `openComposer` function with:

```js
/** opts: { anchor, rect } for new | { existing } to edit | { general } for the doc note. */
function openComposer(opts) {
  closeComposer();
  const existing = opts.existing || opts.general || null;
  const isGeneral = 'general' in opts;
  const composer = buildComposer({
    existing,
    isGeneral,
    anchor: opts.anchor || null,
    onCancel: closeComposer,
    onSubmit: async ({ body, tag, tagLocked }) => {
      if (existing) await patch(existing.id, tagLocked ? body : { ...body, tag });
      else await create({ ...body, tag, ...(isGeneral ? {} : { anchor: opts.anchor }) });
      closeComposer();
      window.getSelection().removeAllRanges();
    },
  });
  popover = el('div', { className: 'comment-popover' }, [composer.node]);
  scroller.append(popover);
  const host = scroller.getBoundingClientRect();
  const rect = opts.rect || rail.getBoundingClientRect();
  const left = Math.min(Math.max(rect.left - host.left, 8), host.width - 316);
  popover.style.left = `${left}px`;
  popover.style.top = `${rect.bottom - host.top + 8}px`;
  composer.focus();
}
```

6. In `public/css/style.css`, rename the selector `.comment-popover-foot` to `.comment-composer-foot`, add `gap: 8px;` to it, and add:

```css
.comment-composer-foot .comment-hint {
  margin-right: auto;
}
.comment-composer-foot .comment-save {
  padding: 4px 12px;
  font-size: 0.8125rem;
}
```

- [ ] **Step 7: Gate + desktop regression check**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all pass.

Then follow `.claude/skills/verifier-web/SKILL.md` (`pnpm uat`) and at 1280×800 on the seeded "Review me" note confirm: Review toggles; selecting text opens the popover with Save/Cancel; ⌥2 then ⌘↵ saves a cut; Cancel and Esc close it; the gutter `+` and the General card open composers that stay open; card Edit/Resolve/Delete work; Copy feedback output is unchanged in shape. `pnpm uat:stop`.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml public/js/el.js public/js/comments-composer.js public/js/comments-composer.test.js public/js/comments-cards.js public/js/comments-cards.test.js public/js/comments-ui.js public/css/style.css
git commit -m "refactor(comments): extract composer and card builders; add Save/Cancel"
```

---

### Task 4: Responsive presentation — drawer, sheets, pill, review bar

**Files:**

- Modify: `public/js/comments-ui.js` (the `initComments` function is replaced; module-level helpers above it are kept)
- Modify: `public/index.html`, `public/css/style.css`, `public/js/app.js`

**Interfaces:**

- Consumes: `layoutFor`, `keyboardInset`, `summarize`, `summaryLabel` (Task 2); `buildComposer`, `buildCard`, `buildGeneralCard`, `el` (Task 3).
- Produces: `initComments(deps)` with two new required deps — `drawer: HTMLElement` (`#comments-drawer`, containing a `.comments-list`) and `listBtn: HTMLButtonElement` (`#comments-list-btn`). The returned controller is unchanged: `{ load, clear, refresh, setReviewMode, isReviewing }`.

No unit tests (DOM + viewport glue); verified in the browser in Task 5. Keep anything that _can_ be pure in `review-layout.js`.

- [ ] **Step 1: Markup**

In `public/index.html`:

1. Add `data-secondary` to the Review button so it moves into the ••• menu below 768px, and add the list button after it:

```html
<button id="review-btn" class="text-btn" aria-pressed="false" data-secondary hidden>Review</button>
<button id="comments-list-btn" class="text-btn" aria-expanded="false" hidden>Comments</button>
```

2. Directly after the closing `</aside>` of `#revisions-drawer` (still inside `.viewer-header`):

```html
<aside
  id="comments-drawer"
  class="revisions-drawer comments-drawer"
  aria-label="Review comments"
  hidden
>
  <div class="comments-list"></div>
</aside>
```

- [ ] **Step 2: Styles**

In `public/css/style.css`, **delete** the A1 block that starts with the comment `/* A1 is desktop-only; tablet and mobile review UI arrive in A2. */` (the whole `@media (max-width: 1023px) { … }` that follows it), and wrap the existing rule

```css
.viewer-scroll.reviewing .markdown-body {
  padding-right: max(316px, calc((100% - 860px) / 2));
}
```

in `@media (min-width: 1024px) { … }`. Then append:

```css
/* ── Review comments: tablet drawer, mobile sheets (phase A2) ────────────── */

/* Cards are absolutely placed only in the desktop rail. */
.comments-list .comment-card,
.comment-popover .comment-card,
.review-sheet .comment-card {
  position: static;
  margin-bottom: 8px;
}
.comment-popover .comment-card,
.review-sheet .comment-card {
  border: 0;
  padding: 0;
  margin: 0;
  cursor: default;
}
.comments-drawer {
  max-height: 40vh;
}

@media (max-width: 1023px) {
  .comments-rail,
  .comment-gutter-btn {
    display: none !important;
  }
}

.comment-pill,
.review-bar,
.review-sheet {
  position: fixed;
  isolation: isolate;
}
/* iOS 26 Safari tints its bars from the background-color of fixed chrome, so
   paint these through ::before instead (same rule as the sticky header). */
.comment-pill::before,
.review-bar::before,
.review-sheet::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
}

.comment-pill {
  right: 16px;
  bottom: calc(16px + env(safe-area-inset-bottom));
  z-index: 66;
  padding: 10px 16px;
  border: 0;
  border-radius: 999px;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  color: #fff;
  box-shadow: var(--shadow-lg);
}
.comment-pill::before {
  background: var(--accent);
}
.review-bar:not([hidden]) ~ .comment-pill {
  bottom: calc(68px + env(safe-area-inset-bottom));
}

.review-bar {
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 65;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--border);
  font-size: 0.875rem;
}
.review-bar[hidden] {
  display: none;
}
.review-bar::before {
  background: var(--bg);
}
.review-bar-summary {
  margin-right: auto;
}

.review-sheet {
  left: 0;
  right: 0;
  bottom: var(--kb-inset, 0px);
  z-index: 70;
  display: flex;
  flex-direction: column;
  max-height: min(70vh, calc(100vh - var(--kb-inset, 0px) - 48px));
  padding: 8px 16px calc(12px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--border);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  box-shadow: var(--shadow-lg);
}
.review-sheet::before {
  background: var(--bg);
}
.review-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 6px;
  font-size: 0.8125rem;
  color: var(--text-secondary);
}
.review-sheet-body {
  overflow-y: auto;
  overscroll-behavior: contain;
}
.review-sheet-quote {
  margin: 0 0 8px;
  padding-left: 8px;
  border-left: 2px solid var(--accent);
  font-size: 0.8125rem;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 16px inputs stop iOS from zooming the page when the note field is focused. */
.review-sheet textarea,
.review-sheet input {
  font-size: 1rem;
}
.review-sheet .comment-tags button {
  font-size: 0.875rem;
  padding: 6px 12px;
}
.review-sheet .comment-hint {
  display: none;
}
.review-sheet .comment-card-actions {
  display: flex;
}

@media (max-width: 767px) {
  /* Room for the review bar so the note's last lines stay reachable. */
  .viewer-scroll.reviewing {
    padding-bottom: calc(64px + env(safe-area-inset-bottom));
  }
}
```

- [ ] **Step 3: Controller**

In `public/js/comments-ui.js`:

1. Add the import:

```js
import { layoutFor, keyboardInset, summarize, summaryLabel } from './review-layout.js';
```

2. Delete the module-level `desktop` constant and its comment.

3. Add this module-level helper after `describeBlock`:

```js
/** The outermost stamped block containing `target` (a whole list, not one item). */
function outermostBlock(root, target) {
  let block = target && target.closest ? target.closest('[data-line]') : null;
  while (block && block.parentElement.closest('[data-line]')) {
    block = block.parentElement.closest('[data-line]');
  }
  return block && root.contains(block) ? block : null;
}
```

4. Replace the whole `export function initComments(deps) { … }` with:

```js
export function initComments(deps) {
  const { root, scroller, rail, drawer, listBtn, reviewBtn, copyBtn, api } = deps;
  const drawerList = drawer.querySelector('.comments-list');
  const coarse = window.matchMedia('(pointer: coarse)');
  let data = { round: 1, items: [] };
  let reviewing = false;
  let activeId = null;
  let popover = null; // composer or item view, rail/drawer layouts
  let composing = false;
  let sheet = null; // bottom sheet, sheet layout
  let sheetKind = null; // 'composer' | 'item' | 'list'
  let sheetBody = null;
  let gutterBtn = null;
  let gutterBlock = null;
  let pill = null;
  let pending = null; // { anchor, rect } captured while the selection existed
  let pendingBlock = null;
  let bar = null;
  let barSummary = null;
  let selectionTimer = 0;
  let currentLayout = layoutFor(window.innerWidth);
  /** @type {Map<string, { range: Range|null, block: Element|null, lines: [number, number] }>} */
  let targets = new Map();

  const note = () => deps.getNote();
  const base = () => `/api/files/${encodeURIComponent(note().id)}/comments`;
  const layout = () => layoutFor(window.innerWidth);
  const active = () => reviewing && deps.canReview();
  // Touch selection never produces a usable mouseup, and on a phone a popover
  // would sit under the native selection callout — both get the pill instead.
  const usesPill = () => coarse.matches || layout() === 'sheet';

  // ── Resolve + paint ───────────────────────────────────────────────────────

  function resolveTargets() {
    targets = new Map();
    const source = deps.getSource();
    if (!source) return;
    for (const item of data.items) {
      if (!item.anchor) continue;
      const hit = locate(source, item.anchor);
      if (!hit) continue;
      const scopes = blockScopes(root, hit.lines);
      const block = blockFor(root, hit.lines) || scopes[0] || null;
      let range = null;
      if (!item.anchor.block && scopes.length) {
        const nth =
          hit.start == null
            ? 0
            : nthInLines(source, unionLines(scopes), hit.start, item.anchor.quote);
        range = rangeForQuote(scopes, item.anchor.quote, nth);
      }
      targets.set(item.id, { range, block, lines: hit.lines });
    }
  }

  function paintHighlights() {
    if (canHighlight) {
      for (const name of [...new Set(Object.values(HIGHLIGHT_FOR)), 'review-active']) {
        CSS.highlights.delete(name);
      }
    }
    for (const node of root.querySelectorAll('.review-block'))
      node.classList.remove('review-block');
    if (!active()) return;
    if (pendingBlock) pendingBlock.classList.add('review-block');
    const groups = {};
    for (const item of data.items) {
      const t = targets.get(item.id);
      if (!t || item.status !== 'open') continue;
      if (t.range) (groups[HIGHLIGHT_FOR[item.tag]] ||= []).push(t.range);
      if (item.id === activeId) {
        if (canHighlight && t.range) CSS.highlights.set('review-active', new Highlight(t.range));
        else if (t.block) t.block.classList.add('review-block');
      }
    }
    if (canHighlight) {
      for (const [name, ranges] of Object.entries(groups)) {
        CSS.highlights.set(name, new Highlight(...ranges));
      }
    }
  }

  // ── Lists: rail (positioned), drawer and list sheet (document order) ──────

  function cardFor(item, orphaned, isActive = item.id === activeId) {
    return buildCard(item, {
      orphaned,
      active: isActive,
      onActivate: () => {
        // In a sheet the note is underneath: get out of the way, then scroll.
        if (layout() === 'sheet') closeFloating();
        activate(item.id, { scroll: true });
      },
      onEdit: () => openComposer({ existing: item }),
      onToggle: () =>
        patch(item.id, { status: item.status === 'open' ? 'addressed' : 'open' }).catch(() => {}),
      onDelete: () => remove(item.id),
    });
  }

  function targetTop(item) {
    const t = targets.get(item.id);
    const rect =
      t && (t.range ? t.range.getBoundingClientRect() : t.block?.getBoundingClientRect());
    if (!rect) return null;
    return rect.top - scroller.getBoundingClientRect().top;
  }

  function renderRail() {
    const general = data.items.find((i) => i.tag === 'general');
    const generalCard = buildGeneralCard(general, () => openComposer({ general }));
    rail.append(generalCard);
    const placed = data.items
      .filter((i) => i.anchor)
      .map((item) => ({ item, top: targetTop(item), orphaned: !targets.has(item.id) }))
      .sort((a, b) => (a.top ?? Infinity) - (b.top ?? Infinity));
    let floor = generalCard.offsetTop + generalCard.offsetHeight + CARD_GAP;
    for (const { item, top, orphaned } of placed) {
      const card = cardFor(item, orphaned);
      rail.append(card);
      const y = Math.max(top ?? floor, floor);
      card.style.top = `${y}px`;
      floor = y + card.offsetHeight + CARD_GAP;
    }
    rail.style.height = `${floor}px`;
  }

  function renderFlatList(host) {
    const general = data.items.find((i) => i.tag === 'general');
    host.append(buildGeneralCard(general, () => openComposer({ general })));
    const line = (item) => targets.get(item.id)?.lines[0] ?? Infinity;
    const anchored = data.items.filter((i) => i.anchor).sort((a, b) => line(a) - line(b));
    for (const item of anchored) host.append(cardFor(item, !targets.has(item.id)));
  }

  function renderList() {
    const mode = layout();
    rail.replaceChildren();
    drawerList.replaceChildren();
    rail.hidden = !(active() && mode === 'rail');
    const count = data.items.length;
    listBtn.hidden = !(active() && mode === 'drawer');
    listBtn.textContent = count ? `Comments · ${count}` : 'Comments';
    if (!active() || mode !== 'drawer') setDrawer(false);
    if (!active()) return;
    if (mode === 'rail') renderRail();
    else if (mode === 'drawer' && !drawer.hidden) renderFlatList(drawerList);
    else if (mode === 'sheet' && sheetKind === 'list') {
      sheetBody.replaceChildren();
      renderFlatList(sheetBody);
    }
  }

  function setDrawer(open) {
    drawer.hidden = !open;
    listBtn.setAttribute('aria-expanded', String(open));
  }

  // ── Review bar (sheet layout) ─────────────────────────────────────────────

  function renderBar() {
    const show = active() && layout() === 'sheet';
    if (!bar) {
      if (!show) return;
      barSummary = el('button', { type: 'button', className: 'text-btn review-bar-summary' });
      barSummary.addEventListener('click', () => {
        if (sheetKind === 'list') return closeFloating();
        openSheet('list', 'Comments', []);
        renderList();
      });
      const copy = el('button', {
        type: 'button',
        className: 'text-btn',
        textContent: 'Copy feedback',
      });
      copy.addEventListener('click', () => copyFeedback(copy));
      const done = el('button', { type: 'button', className: 'primary-btn', textContent: 'Done' });
      done.addEventListener('click', () => setReviewMode(false));
      bar = el('div', { className: 'review-bar' }, [barSummary, copy, done]);
      // Before the pill in DOM order: the pill's CSS lifts it above a shown bar.
      document.body.insertBefore(bar, pill);
    }
    bar.hidden = !show;
    if (show) barSummary.textContent = summaryLabel(summarize(data.items));
  }

  function repaint() {
    // An item view shows a snapshot of one comment; anything that repaints may
    // have changed it. The composer holds unsaved input, so it is left alone.
    if (!composing) closeFloating({ keepList: true });
    resolveTargets();
    paintHighlights();
    renderList();
    renderBar();
    copyBtn.hidden = !(note() && note().owned && data.items.length);
  }

  function activate(id, { scroll = false } = {}) {
    activeId = id;
    paintHighlights();
    for (const card of document.querySelectorAll('.comment-card[data-id]')) {
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
      // The source we anchored against is stale; reload the whole note (which
      // also reloads comments and drops review mode), then re-enter review.
      const wasReviewing = reviewing;
      closeFloating();
      await deps.reloadNote();
      if (wasReviewing) setReviewMode(true);
      window.alert('The note changed and was reloaded. Select the text again.');
      return;
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save');
    const { item } = await res.json();
    data.items.push(item);
    activeId = item.id;
    repaint();
  }

  async function patch(id, body) {
    const res = await api(`${base()}/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save');
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
    copyBtn.hidden = true;
    const current = note();
    if (current && current.owned) {
      try {
        const res = await api(base());
        if (res.ok && note() && note().id === current.id) data = await res.json();
      } catch {}
    }
    repaint();
  }

  function copyFeedback(flashOn) {
    const current = note();
    if (!current) return;
    const text = formatFeedback(data, deps.getSource(), {
      title: deps.getTitle(),
      rev: current.currentRev,
    });
    navigator.clipboard
      .writeText(text)
      .then(() => deps.flashCopied(flashOn))
      .catch(() => {});
  }

  // ── Floating UI: popover (≥768) and bottom sheet (<768) ───────────────────

  function syncInset() {
    const vv = window.visualViewport;
    const inset = vv
      ? keyboardInset({
          innerHeight: window.innerHeight,
          vvHeight: vv.height,
          vvOffsetTop: vv.offsetTop,
        })
      : 0;
    document.documentElement.style.setProperty('--kb-inset', `${inset}px`);
  }

  function openSheet(kind, title, children) {
    closeFloating();
    const close = el('button', { type: 'button', className: 'text-btn', textContent: 'Close' });
    close.addEventListener('click', () => closeFloating());
    sheetBody = el('div', { className: 'review-sheet-body' }, children);
    sheet = el('div', { className: 'review-sheet' }, [
      el('div', { className: 'review-sheet-head' }, [el('span', { textContent: title }), close]),
      sheetBody,
    ]);
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', title);
    sheetKind = kind;
    document.body.append(sheet);
    syncInset();
  }

  function openPopover(children, rect) {
    popover = el('div', { className: 'comment-popover' }, children);
    scroller.append(popover);
    const host = scroller.getBoundingClientRect();
    const at = rect || (rail.hidden ? listBtn : rail).getBoundingClientRect();
    const left = Math.min(Math.max(at.left - host.left, 8), host.width - 316);
    popover.style.left = `${left}px`;
    popover.style.top = `${at.bottom - host.top + 8}px`;
  }

  /** Close the popover and any sheet; `keepList` leaves an open list sheet up. */
  function closeFloating({ keepList = false } = {}) {
    if (popover) popover.remove();
    popover = null;
    if (sheet && !(keepList && sheetKind === 'list')) {
      sheet.remove();
      sheet = null;
      sheetKind = null;
      sheetBody = null;
    }
    composing = false;
  }

  /** opts: { anchor, rect } for new | { existing } to edit | { general } for the doc note. */
  function openComposer(opts) {
    closeFloating();
    hidePill();
    const existing = opts.existing || opts.general || null;
    const isGeneral = 'general' in opts;
    const composer = buildComposer({
      existing,
      isGeneral,
      anchor: opts.anchor || null,
      onCancel: () => closeFloating(),
      onSubmit: async ({ body, tag, tagLocked }) => {
        if (existing) await patch(existing.id, tagLocked ? body : { ...body, tag });
        else await create({ ...body, tag, ...(isGeneral ? {} : { anchor: opts.anchor }) });
        closeFloating();
        window.getSelection().removeAllRanges();
      },
    });
    if (layout() === 'sheet') {
      const target = opts.anchor || (existing && existing.anchor) || null;
      const quoted = target
        ? [
            el('p', {
              className: 'review-sheet-quote',
              textContent: target.block ? `[${target.block.label}]` : target.quote,
            }),
          ]
        : [];
      openSheet('composer', isGeneral ? 'General note' : 'Comment', [...quoted, composer.node]);
    } else {
      openPopover([composer.node], opts.rect);
    }
    composing = true;
    composer.focus();
  }

  /** Tap on a highlight where there is no rail: show that one comment. */
  function openItem(item, rect) {
    closeFloating();
    activate(item.id);
    const card = cardFor(item, false, true);
    if (layout() === 'sheet') openSheet('item', `${item.id} · ${item.tag}`, [card]);
    else openPopover([card], rect);
  }

  // ── Selection, pill, gutter ───────────────────────────────────────────────

  function closestBlock(node) {
    const e = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return e ? e.closest('[data-line]') : null;
  }

  /** The current selection as { anchor, rect }, or null when it is not commentable. */
  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    const first = closestBlock(range.startContainer);
    const last = closestBlock(range.endContainer);
    if (!first || !last) return null;
    const spanned = [
      Math.min(parseLines(first)[0], parseLines(last)[0]),
      Math.max(parseLines(first)[1], parseLines(last)[1]),
    ];
    const scopes = blockScopes(root, spanned);
    const lines = unionLines(scopes) || spanned;
    const text = sel.toString();
    const nth = occurrenceAt(scopes, text, range.startContainer, range.startOffset);
    const anchor = captureAnchor(deps.getSource(), lines, text, nth);
    return anchor.quote ? { anchor, rect: range.getBoundingClientRect() } : null;
  }

  function showPill(label, capture, block = null) {
    pending = capture;
    pendingBlock = block;
    pill.textContent = label;
    pill.hidden = false;
    paintHighlights();
  }

  function hidePill() {
    pending = null;
    const hadBlock = pendingBlock;
    pendingBlock = null;
    if (pill) pill.hidden = true;
    if (hadBlock) paintHighlights();
  }

  function onSelectionChange() {
    clearTimeout(selectionTimer);
    // Handles are still being dragged while this fires; wait for them to settle.
    selectionTimer = setTimeout(() => {
      if (!active() || !usesPill() || composing) return;
      const capture = captureSelection();
      if (capture) showPill('Comment', capture);
      else if (!pendingBlock) hidePill();
    }, 200);
  }

  function onSelectionEnd(e) {
    if (!active() || usesPill() || isChrome(e.target)) return;
    const capture = captureSelection();
    if (capture) openComposer(capture);
  }

  function isChrome(target) {
    return [rail, drawer, listBtn, gutterBtn, popover, sheet, bar, pill].some(
      (node) => node && node.contains(target)
    );
  }

  function onClick(e) {
    if (!active() || isChrome(e.target)) return;
    const collapsed = window.getSelection().isCollapsed;
    if (popover && collapsed) closeFloating();
    if (!collapsed) return;
    if (!root.contains(e.target)) return hidePill();
    for (const item of data.items) {
      const t = targets.get(item.id);
      if (!t || !t.range || item.status !== 'open') continue;
      const rects = [...t.range.getClientRects()];
      const hit = rects.some(
        (r) =>
          e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      );
      if (!hit) continue;
      hidePill();
      if (layout() === 'rail') {
        activate(item.id);
        rail.querySelector(`[data-id="${item.id}"]`)?.scrollIntoView({ block: 'nearest' });
      } else {
        openItem(item, rects[rects.length - 1]);
      }
      return;
    }
    // Touch has no hover, so a plain tap on a block offers the block comment.
    if (!usesPill()) return;
    const block = outermostBlock(root, e.target);
    if (!block || block === pendingBlock) return hidePill();
    const { kind, label } = describeBlock(block);
    showPill(
      'Comment on block',
      { anchor: blockAnchor(parseLines(block), kind, label), rect: block.getBoundingClientRect() },
      block
    );
  }

  function onHover(e) {
    if (!active() || popover || usesPill() || layout() !== 'rail') return;
    if (gutterBtn && gutterBtn.contains(e.target)) return;
    const block = outermostBlock(root, e.target);
    if (!block) return;
    if (!gutterBtn) {
      gutterBtn = el('button', {
        className: 'comment-gutter-btn',
        type: 'button',
        textContent: '+',
        title: 'Comment on this block',
      });
      gutterBtn.setAttribute('aria-label', 'Comment on this block');
      gutterBtn.addEventListener('click', () => {
        if (!gutterBlock || !gutterBlock.isConnected) return;
        const { kind, label } = describeBlock(gutterBlock);
        openComposer({
          anchor: blockAnchor(parseLines(gutterBlock), kind, label),
          rect: gutterBlock.getBoundingClientRect(),
        });
      });
      scroller.append(gutterBtn);
    }
    const host = scroller.getBoundingClientRect();
    const rect = block.getBoundingClientRect();
    gutterBlock = block;
    gutterBtn.hidden = false;
    gutterBtn.style.top = `${rect.top - host.top}px`;
    gutterBtn.style.left = `${Math.max(rect.left - host.left - 30, 0)}px`;
  }

  // ── Mode + public API ─────────────────────────────────────────────────────

  function setReviewMode(on) {
    const next = Boolean(on && note() && note().owned && deps.canReview());
    if (next === reviewing) return;
    reviewing = next;
    reviewBtn.setAttribute('aria-pressed', String(reviewing));
    scroller.classList.toggle('reviewing', reviewing);
    if (!reviewing) {
      closeFloating();
      hidePill();
      setDrawer(false);
      if (gutterBtn) gutterBtn.hidden = true;
      activeId = null;
    }
    repaint();
    deps.onModeChange();
  }

  function onResize() {
    const next = layout();
    if (next !== currentLayout) {
      // Rotation or a window resize across a breakpoint: stay in review mode,
      // drop floating UI that belongs to the old layout.
      currentLayout = next;
      closeFloating();
      hidePill();
      setDrawer(false);
      if (gutterBtn) gutterBtn.hidden = true;
    }
    if (reviewing) repaint();
  }

  pill = el('button', { type: 'button', className: 'comment-pill', hidden: true });
  // Keep the text selection alive through the tap; the anchor was captured
  // when the selection settled, so nothing depends on it surviving the click.
  pill.addEventListener('pointerdown', (e) => e.preventDefault());
  pill.addEventListener('click', () => {
    const capture = pending;
    if (capture) openComposer(capture);
  });
  document.body.append(pill);

  reviewBtn.addEventListener('click', () => setReviewMode(!reviewing));
  copyBtn.addEventListener('click', () => copyFeedback(copyBtn));
  listBtn.addEventListener('click', () => {
    setDrawer(drawer.hidden);
    renderList();
  });
  document.addEventListener('mouseup', onSelectionEnd);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('click', onClick);
  root.addEventListener('mouseover', onHover);
  window.addEventListener('resize', onResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncInset);
    window.visualViewport.addEventListener('scroll', syncInset);
  }

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

Notes for the implementer:

- `paintHighlights` now also outlines `pendingBlock` (the block a touch user tapped) using the existing `.review-block` class.
- `onClick` now ignores non-open items when hit-testing, since addressed items have no highlight to tap.
- `renderBar` inserts the bar **before** the pill in `document.body` so the CSS sibling rule `.review-bar:not([hidden]) ~ .comment-pill` lifts the pill above it.
- The gutter no longer stores the block as an expando on the button (`gutterBlock` variable + `isConnected` guard).

- [ ] **Step 4: Wire `app.js`**

Add DOM refs next to `reviewBtn`:

```js
const commentsListBtn = document.getElementById('comments-list-btn');
const commentsDrawer = document.getElementById('comments-drawer');
```

Add to the `initComments({ … })` call:

```js
drawer: commentsDrawer,
listBtn: commentsListBtn,
```

Nothing else in `app.js` changes: `headerLocked()` already returns true while reviewing, which keeps the sticky header (and the drawer inside it) on screen.

- [ ] **Step 5: Gate**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all pass. Use `pnpm exec prettier --write` on touched files if format fails.

- [ ] **Step 6: Smoke check**

Follow `.claude/skills/verifier-web/SKILL.md` (`pnpm uat`). On "Review me": at 1280 wide the rail still works and the pill never shows with a mouse; at 820 wide Review shows a "Comments · 4" button that opens the drawer; with the mobile preset (375, touch) Review is in the ••• menu and the review bar appears. No console errors. `pnpm uat:stop`. Full verification is Task 5.

- [ ] **Step 7: Commit**

```bash
git add public/js/comments-ui.js public/index.html public/css/style.css public/js/app.js
git commit -m "feat(frontend): review mode on tablet and mobile — drawer, bottom sheets, comment pill, review bar"
```

---

### Task 5: Browser verification across viewports, docs

**Files:**

- Modify: `CLAUDE.md`, `.claude/skills/verifier-web/SKILL.md`
- Fixes in any Task 1–4 file if a check fails (own `fix(...)` commit, documented in the report)

**Interfaces:** consumes everything above; produces the verified feature and accurate docs.

- [ ] **Step 1: Verify in a real browser**

Follow the `verifier-web` skill (`pnpm uat`; `pnpm uat:stop` at the end). Use the seeded "Review me" note. The `mobile` resize preset emulates touch, so `(pointer: coarse)` matches there; reload after switching presets. Where real touch selection cannot be driven, build the selection with `window.getSelection()` + a `Range` on the real text nodes (this fires `selectionchange` by itself) and say so in the report. Record PASS/FAIL with DOM/state evidence for each check; screenshots go under `.superpowers/` scratch, never committed.

**Desktop 1280×800 (regression)**

1. Rail, highlights, gutter `+`, selection popover (now with Save/Cancel), ⌥2 + ⌘↵, card Edit/Resolve/Delete and Copy feedback behave as in A1. The pill never appears with a mouse (`.comment-pill[hidden]`).

**Tablet 820×1180, fine pointer**

2. Review on → no rail (`#comments-rail[hidden]`), toolbar shows `Comments · 4`; text column is full width (no 316px right padding).
3. `Comments · 4` opens the drawer inside the sticky header: General first, then cards in document order; drawer scrolls internally; header does not auto-hide while scrolling the note.
4. Clicking a drawer card scrolls its anchor to center and outlines/highlights it.
5. Clicking a highlight in the note opens a popover with that comment's card and visible Edit / Resolve / Delete; Resolve closes it, removes the highlight, and the drawer count/list update.
6. Mouse-selecting text opens the composer popover at the selection; Save adds a card to the open drawer.

**Tablet 820×1180, touch** (mobile-style emulation at 820 wide, or DevTools touch)

7. Selecting text shows the "Comment" pill bottom-right and does **not** open a composer by itself; tapping the pill opens the popover composer and the selection is still visible behind it.
8. Tapping a paragraph with no selection outlines it and shows "Comment on block"; tapping elsewhere outside the note clears both.

**Phone 375×812 (mobile preset), light then dark**

9. Review is reachable from the ••• menu. Once on: bottom review bar shows `3 open · 1 keep`, Copy feedback, Done; the note has bottom padding (last line scrolls clear of the bar); no rail, no gutter button.
10. Selecting text shows the pill **above** the bar. Tapping it opens the bottom sheet: quoted text (clamped to 2 lines), tag chips, 16px note field focused, Save/Cancel, no keyboard-shortcut hint.
11. With the sheet open, simulate the keyboard: `document.documentElement.style.setProperty('--kb-inset','300px')` moves the sheet up 300px and its `max-height` shrinks so the head stays on screen. (Then dispatch a `visualViewport` resize, or reload, to reset.)
12. Pick `cut` → Save with an empty note → sheet closes, selection cleared, the text is struck through, bar count becomes `4 open · 1 keep`.
13. Tap the summary in the bar → list sheet with all cards in document order; it scrolls inside itself while the page behind does not move; tapping a card closes the sheet and scrolls the note to the anchor. Tapping the summary again with the list open closes it.
14. Tap a highlight → item sheet titled `c1 · fix` with actions; Edit swaps to the composer sheet prefilled; Save returns to the note with the card updated.
15. Tap a table → "Comment on block" pill → sheet quotes `[table under "Costs"]`.
16. Copy feedback in the bar copies the same text the desktop button produces; the button flashes "Copied!".
17. Done exits review: bar, pill, sheets gone; highlights cleared; bottom padding removed.
18. Rotate (resize to 812×375 → still `sheet`; then to 1024×768 → `rail`) while reviewing: review mode stays on, floating UI closes, the rail appears; back to 375 → bar returns.
19. Non-owner: open the seeded link-shared note owned by `other_user` at 375 — no Review entry in •••, no bar, no pill on selection.
20. iOS rule audit: `getComputedStyle` of `.review-bar`, `.review-sheet`, `.comment-pill` reports `background-color: rgba(0, 0, 0, 0)` (painted via `::before`).

Fix anything that fails (minimal change, right file), re-run the gate, re-verify, and commit each fix separately.

- [ ] **Step 2: Docs**

In `CLAUDE.md`:

- Frontend file list — add `public/js/review-layout.js` (pure layout/keyboard-inset/summary helpers, unit-tested), `public/js/comments-composer.js` and `public/js/comments-cards.js` (DOM builders, unit-tested under happy-dom), `public/js/el.js`. Reword the `comments-ui.js` line to: "review mode controller: anchoring, highlights, and presentation per layout (rail ≥1024, drawer 768–1023, bottom sheets <768)".
- Testing — add: "`public/js/comments-*.test.js` use a per-file `// @vitest-environment happy-dom`; everything else in the unit project stays in node."
- Key Patterns — replace the A1 sentence "Review mode is desktop-only (≥1024px) until phase A2" with: "Review mode presents per layout (`review-layout.js`): margin rail ≥1024, a list drawer inside the sticky header at 768–1023, and below 768 a bottom review bar + bottom sheets. Input mode follows the pointer, not the width: `(pointer: coarse)` or the sheet layout shows a floating Comment pill on `selectionchange` (anchor captured then; `pointerdown` is prevented so the tap keeps the selection) — fine pointers keep the mouseup popover. Fixed review chrome paints its background via `::before` (iOS 26 rule) and the sheet rides above the keyboard with `--kb-inset` from `visualViewport`."

In `.claude/skills/verifier-web/SKILL.md`, under the "Review me" scenario add one line: review mode must be checked at 1280 (rail), 820 (drawer) and the mobile preset (pill, sheets, bar).

- [ ] **Step 3: Gate and commit**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`

```bash
git add CLAUDE.md .claude/skills/verifier-web/SKILL.md
git commit -m "docs(comments): review mode layouts and touch input"
```

---

## Done when

- `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` pass.
- All 20 browser checks pass (9–17 in light and dark).
- A1 desktop behavior is unchanged apart from the composer's Save/Cancel buttons.
- PR opened per the Branching note (do not deploy; CI deploys on merge).
- A manual pass on a real iPhone and iPad is called out in the PR description as still required: native selection handles, the callout menu not covering the pill, and the keyboard inset cannot be fully proven in emulation.

## Carry-over to A3

Found by A2's final review and deliberately deferred. Do these first in the A3 plan.

**Deferred minors**

- Sidebar open on a phone hides the review bar and pill but not an open sheet.
- Pill can hide under a slow (>200 ms) press if iOS collapses the selection at touchstart — suppress `hidePill` between pill `pointerdown` and `pointerup`.
- `showPill` repaints highlights on every settled selection; `resolveTargets` re-queries `[data-line]` per item (build the block table once per repaint — matters at the 500-comment cap on phones).
- Accessibility: `aria-modal` + focus move/return for sheets, Escape outside the composer and in the drawer, keyboard-operable cards.
- `(pointer: coarse)` only: touch laptops cannot comment by touch (`any-pointer`). Landscape phones get drawer + popover in ~375px of height — consider sheet when coarse and short.
- No tests for the controller state machine (`composing`, `closeFloating`, `keepList`, `onResize`, `pending`, the save token); a small happy-dom test of `initComments` would lock down the `showLogin` teardown.
- ••• menu "Review" item shows no on/off state. `RAIL_MIN_WIDTH` / `DRAWER_MIN_WIDTH` exported but unused. The 400 ms perf-test bound is timing-based (19 ms measured).
- From A1, still open: CRLF sources leave `\r` in quotes; typographer `©`/`±`/`™` pairs fall to `approx`; the 409 alert says "reloaded" even if the reload GET failed.

**Real-device checks still owed (A2):** iPhone + iPad pass per the PR description — native selection handles, callout menu vs pill/bar, fast and slow pill press, keyboard inset (incl. emoji/QuickType switch), iOS 26 bar tinting, tap-a-highlight / tap-a-block on WebKit, landscape composer focus-zoom, iPad portrait toolbar.
