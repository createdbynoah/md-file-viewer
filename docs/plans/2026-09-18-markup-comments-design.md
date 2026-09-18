# Markup Comments + Agent Feedback — Design

Date: 2026-09-18
Status: approved design, pre-implementation

## Goal

Let the note owner comment on a specific word, phrase, or block of a rendered note, then hand those comments to an AI agent as a compact, precise feedback block that the agent applies to the document it already produced. Each review round builds on the last: addressed comments drop out, unaddressed ones carry over, and approved passages stay protected.

## Decisions

| Question        | Decision                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Delivery        | Clipboard first ("Copy feedback"); same format later served by an API endpoint + MCP (phase B)           |
| Comment kinds   | Free text + one intent tag: `fix` (default), `cut`, `q` (question), `keep`; optional literal replacement |
| Who comments    | Owner only. `authorId` stored so editors can be added later without migration                            |
| Lifecycle       | Auto-triage when a new revision lands                                                                    |
| Anchoring       | Quote selector resolved against the raw markdown source, plus source line range                          |
| Document source | Never modified by commenting                                                                             |

Rejected: rendered-text-only anchoring (quotes may not exist verbatim in the agent's file; no line numbers); inline CriticMarkup as storage (every comment becomes an edit and a revision, pollutes Copy Markdown and the shared view). CriticMarkup survives as an optional export flavor.

## UX

### Review mode

A toolbar toggle, owner only, off by default. Off: the note reads clean — no highlights, selection behaves normally. On: highlights are drawn and selecting text starts a comment. While on, the sticky header does not auto-hide (same treatment as editing). Review mode is unavailable while editing or while viewing an old revision.

### Creating a comment

- **Desktop:** select text → a popover appears at the selection with the input focused. `1`–`4` pick the tag, `⌘↵` saves, `esc` cancels. `cut` and `keep` save with an empty note.
- **Mobile:** native long-press selection; the iOS callout is left alone. While a selection exists, a floating "Comment" pill shows bottom-right. Tapping it opens a bottom sheet: quoted text, tag chips, input, Save. The sheet tracks `visualViewport` so it sits above the keyboard. No `background` on the sheet's top edge element (iOS 26 status-bar tint rule; use `::before`).
- **Block comment:** desktop shows a gutter `+` on block hover; on mobile, tapping a block with no selection offers "Comment on block". Used for code blocks, tables, images, headings, whole paragraphs. Selections inside a code block anchor at line granularity.
- **General note:** one unanchored entry per note, created from the rail / list sheet.
- **Literal replacement:** the composer has an optional "Replace with" field; when filled, the export emits `"old" => "new"`.

### Reading comments

| Viewport   | Presentation                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| ≥1024px    | Margin rail right of the note. Cards align to their anchor's top and push down on collision. Hover/click links card and highlight both ways |
| 768–1023px | No rail. Clicking a highlight opens a popover. A toolbar button opens a list drawer (same pattern as the revisions drawer)                  |
| <768px     | Tapping a highlight opens the bottom sheet. A sticky bottom review bar shows counts, opens the list sheet, and carries "Copy feedback"      |

Highlight colors: `fix`/`q` highlight tint, `keep` success tint, `cut` danger tint with strikethrough. All via theme custom properties so light/dark both work.

### After a new revision

A banner in review mode: "Round 2: 4 addressed · 1 carried over · 1 keep violated". Addressed comments collapse under a disclosure, each with "Reopen" and a mini-diff (old quote → `replacedBy`, rendered with the existing jsdiff). Violated keeps are pinned first in danger color with two actions: "Accept change" (drops the keep) or leave it (exports under VIOLATED).

### Copy feedback

Always present in the toolbar (desktop) or review bar (mobile); `data-secondary` when review mode is off, so it moves to the ••• menu below 768px. Uses `flashCopied`. A ▾ menu offers: open only (default), include addressed, inline CriticMarkup.

## Feedback format

Plain text, line-oriented. JSON is avoided as the default because quoting, escaping, and keys roughly double the token cost.

```
# feedback · "Rollout plan" · rev 3 · round 2
# Quotes are exact substrings of the markdown source (~ = rendered text, match loosely). L = line @ rev 3.
# fix=revise per note · cut=delete · q=answer, don't edit · keep=leave byte-identical
# Edit the existing doc in place; change nothing else. Then list any ids you didn't apply + why.

VIOLATED — kept text was changed; restore it
k2 L30 "p95 under 200 ms"

KEEP
k1 L12 "Rollback is a one-line flag flip."

OPEN
c3 fix L40 "soon" (carried: unchanged since round 1)
  Give a date
c4 fix L8 "all customers in a single release"
  Stage it: 5% → 25% → 100%
c5 cut L14 "This section is intentionally left brief."
c6 q L15 "existing dashboards"
  Which ones?
c7 fix L20-34 [table under "Costs"]
  Add a totals row
c8 fix L9 "the beta" => "the closed beta"
c9 fix L52 "latency" <in "…tail [latency] dominates…">
  Define on first use

GENERAL
  Tone is too salesy overall
```

Rules:

1. One line per anchor: `id tag L<range> "<quote>"`. The note follows on an indented line. `cut` and `keep` need no note.
2. The quote is an exact source substring — usable directly as an edit tool's `old_string`. It is prefixed `~` only when the selection did not resolve verbatim in the source (`anchor.approx`).
3. Disambiguating context `<in "…pre [quote] post…">` is emitted only when the quote occurs more than once in the current source.
4. Quotes longer than 12 words are elided: `"first five words … last five words"`; the line range carries the precision.
5. Block anchors use a bracketed descriptor instead of a quote: `[table under "Costs"]`, `[code block, js]`, `[image "arch.png"]`, `[section "Risks"]`.
6. A literal replacement is `"old" => "new"` on the anchor line, with no note line.
7. Ids are short, stable, per note, never reused: `c<n>` for fix/cut/q, `k<n>` for keep, drawn from one `nextId` counter.
8. Section order: VIOLATED, KEEP, OPEN (document order), GENERAL. Empty sections are omitted.
9. Addressed comments are never exported by default, so each round costs roughly (open + keeps) × 15–25 tokens plus the ~60-token legend. The legend is always included; a fresh agent session has no memory of it.
10. The header's rev stamp lets an API-capable agent fetch that exact revision; an agent whose copy has drifted falls back on quotes.

Alternate export — inline CriticMarkup: the full source with `{==quote==}{>>c4 fix: note<<}` embedded, for agents with no copy of the document. Costs the whole document in tokens; never the default.

One generator, `formatFeedback(comments, source, meta, opts)`, produces both the clipboard text and (phase B) the endpoint body.

## Data model

One KV value per note at `comments:{uuid}`. Owner-only, last-write-wins. Removed by `deleteNoteObjects()`. Cap 500 items (POST answers 400 beyond it).

```js
{
  nextId: 10,
  round: 2,
  items: [{
    id: 'c4',
    tag: 'fix' | 'cut' | 'q' | 'keep' | 'general',
    note: 'Stage it: 5% → 25% → 100%',
    replace: undefined,              // literal replacement text, optional
    anchor: {                        // absent for 'general'
      quote: 'all customers in a single release',
      approx: false,                 // true → quote is rendered text
      prefix: '…32 chars…',
      suffix: '…32 chars…',
      lines: [8, 8],                 // 1-based source lines at `rev`
      block: undefined,              // { kind, label } for block anchors
    },
    rev: 3,                          // revision the anchor is resolved against
    status: 'open' | 'addressed' | 'violated',
    carried: 1,                      // rounds survived unaddressed
    resolvedRev: undefined,
    replacedBy: undefined,           // text now between prefix and suffix
    authorId: '<sub>',
    createdAt: '<iso>',
  }],
}
```

## Anchoring

Capture (client):

1. A markdown-it core rule stamps `data-line="start,end"` on block-level tokens from `token.map`.
2. On selection, find the closest `[data-line]` ancestor(s) of the range, slice those source lines, and `indexOf(selectedText)`.
3. Hit → exact source quote plus 32 characters of prefix and suffix. Miss (selection crosses inline formatting, or spans blocks) → `approx: true`, store the rendered text and the union line range.

Drawing: the CSS Custom Highlight API (`::highlight(review-fix)`, `review-keep`, `review-cut`). No DOM mutation, so hljs spans, table wrappers, and code copy buttons are untouched. Clicks and rail positions come from hit-testing `range.getClientRects()`. Supported in Safari 17.2+ and current Chrome and Firefox; where `CSS.highlights` is missing, review mode still works through the rail/list, without inline highlights.

Locate (shared, pure): exact match → whitespace-normalized match → gone. Multiple hits are ranked by prefix/suffix agreement, then by distance from the previous line. There is deliberately no fuzzy matching: any change inside the quote counts as changed.

## Triage

Runs server-side inside `PUT /api/files/:id`, where old and new source are both already in hand. The clipboard-paste-into-Edit path and the phase-B agent PUT path therefore behave identically.

| Tag            | Anchor found in new source      | Anchor gone                                                        |
| -------------- | ------------------------------- | ------------------------------------------------------------------ |
| `fix`, `cut`   | stays `open`, `carried++`       | `addressed`, `resolvedRev` set, `replacedBy` captured if locatable |
| `keep`         | stays, re-anchored silently     | `violated`                                                         |
| `q`, `general` | unchanged — manual resolve only | `q`: falls back to its block; still manual                         |

- Block anchors compare the block's source text.
- `approx` anchors are located by whitespace-normalized match of the rendered quote against the source with inline markers (`*`, `_`, `` ` ``, link syntax) stripped.
- `round++` when a revision lands while at least one item is `open` or `violated`.
- Reopen (`addressed` → `open`): re-anchor to `replacedBy` if it can be located, otherwise to the containing block.
- A triage failure never fails the PUT: it is logged and comments are left untouched at their old `rev`; the client shows them as "unverified" until the next successful triage.

## API

All owner-only; non-owners and missing notes answer 404, matching the existing ownership rule.

| Method | Path                           | Purpose                                                               |
| ------ | ------------------------------ | --------------------------------------------------------------------- |
| GET    | `/api/files/:id/comments`      | `{ round, items }`                                                    |
| POST   | `/api/files/:id/comments`      | Create; server assigns `id`, `rev = currentRev`, `authorId`           |
| PATCH  | `/api/files/:id/comments/:cid` | `note`, `tag`, `replace`, `status` (reopen / resolve / accept change) |
| DELETE | `/api/files/:id/comments/:cid` | Delete one                                                            |
| GET    | `/api/files/:id/feedback`      | Phase B. `text/plain`; `?format=json`; `?include=addressed`           |

POST validates the anchor against the current source (quote must locate, or `approx` with a valid line range); a stale client gets 409 and refetches.

Phase B auth: bearer tokens `mdv_…`, stored hashed at `token:{sha256}` → `sub`, checked in `resolveUser()` after the UAT stub short-circuit and before the Access JWT path. Scoped to files, comments, and feedback routes. A thin MCP server then exposes `get_doc`, `get_feedback`, `put_doc`, `reply(id)`.

## Modules

`public/js/app.js` is already 1,657 lines; it gains wiring only.

| File                           | Kind | Responsibility                                                     |
| ------------------------------ | ---- | ------------------------------------------------------------------ |
| `public/js/anchor.js`          | pure | capture → anchor, `locate(source, anchor)`, occurrence counting    |
| `public/js/triage.js`          | pure | `triage(items, oldSource, newSource, newRev)`; imported by worker  |
| `public/js/feedback-format.js` | pure | `formatFeedback(...)`; imported by worker in phase B               |
| `public/js/comments-ui.js`     | DOM  | selection, highlights, popover, rail, sheet, review bar, banner    |
| `src/worker.js`                | —    | comment routes; triage call in PUT; cleanup in `deleteNoteObjects` |

## Testing

- **Unit** (pure modules): duplicate quotes and context emission; selection crossing inline formatting → `approx`; multi-block selection; elision at 12 words; every triage transition including block and approx anchors; reopen re-anchoring; format snapshots for each section and for empty sections.
- **Integration** (`src/comments.integration.test.js`): CRUD; second user gets 404 on every route; POST with stale anchor → 409; triage on PUT across two revisions; ids never reused after delete; `comments:{uuid}` removed with the note; cap enforcement.
- **UAT:** seed scenario — a note with comments of every tag across two revisions (one addressed, one carried, one violated keep). Verified via `verifier-web` at 1280, 820, and 375 widths, light and dark.

## Phasing

Each phase is its own PR.

1. **A1** — `data-line` stamping, `anchor.js`, comment CRUD, desktop popover + rail, `feedback-format.js`, Copy feedback.
2. **A2** — tablet drawer/popover; mobile pill, bottom sheet, review bar.
3. **A3** — `triage.js` in PUT, round banner, addressed disclosure with mini-diff, violated-keep actions.
4. **B** — API tokens, `/feedback` endpoint, MCP server.

## Out of scope

Threads and replies in the UI, multi-author display, notifications, comments by link viewers, comments on old revisions, fuzzy re-anchoring.
