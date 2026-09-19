// Turns a note's comments into the compact plain-text block handed to an agent.
// Pure; used by the Copy feedback button now and by GET /feedback later.
import { findAll, locate } from './anchor.js';

const ELIDE_OVER_WORDS = 12;
const ELIDE_KEEP_WORDS = 5;
const CONTEXT_CHARS = 16;

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const flat = (s) => s.replace(/\s+/g, ' ');

// The single helper for EVERY piece of user/derived text placed inside a
// CriticMarkup `{>>...<<}` comment (note, replacement, block label,
// degraded/approx quote, violated quote) — so no call site can forget either
// half: break the four CriticMarkup delimiters that would otherwise escape
// the comment or corrupt a highlight span, and flatten to one line (a raw
// newline inside a comment is just as unsafe as a literal delimiter).
// `formatFeedback` keeps its own `esc` behavior (backslash-n) untouched.
const neutralizeCm = (s) =>
  s
    .replace(/<<\}/g, '<< }')
    .replace(/\{>>/g, '{ >>')
    .replace(/==\}/g, '== }')
    .replace(/\{==/g, '{ ==')
    .replace(/\s+/g, ' ')
    .trim();
const hasCmDelimiter = (s) => ['<<}', '{>>', '==}', '{=='].some((d) => s.includes(d));

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

/** `hit` is `locate(source, item.anchor)` — null when the anchor is gone. */
function itemLines(item, source, round, hit) {
  const showTag = item.tag !== 'keep';
  const resolved = item.status === 'addressed' || item.status === 'violated';
  const at = resolved
    ? item.resolvedLines || item.anchor.lines
    : hit
      ? hit.lines
      : item.anchor.lines;
  let head = `${item.id}${showTag ? ` ${item.tag}` : ''} ${lineRef(at)} ${anchorText(item.anchor, source)}`;
  if (item.replace) head += ` => "${esc(item.replace)}"`;
  if (item.carried > 0) head += ` (carried: unchanged since round ${round - item.carried})`;
  if (item.status === 'addressed' && item.resolvedRev != null) {
    head += ` (addressed in rev ${item.resolvedRev})`;
  }
  if (!hit && !resolved) head += ' (anchor not found in current source)';
  const lines = [head];
  if (item.note && !item.replace) lines.push(...item.note.split('\n').map((l) => `  ${l}`));
  return lines;
}

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
  // The legend promises "L = line @ rev {current}", so resolve every anchor
  // against the source once and print (and sort by) where it sits NOW.
  const hits = new Map(anchored.map((i) => [i, locate(source, i.anchor)]));
  const lineOf = (i) =>
    (i.status === 'addressed' || i.status === 'violated'
      ? i.resolvedLines || i.anchor.lines
      : (hits.get(i) || i.anchor).lines)[0];
  const byPosition = (a, b) => lineOf(a) - lineOf(b) || a.id.localeCompare(b.id);
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
    for (const item of [...list].sort(byPosition))
      out.push(...itemLines(item, source, round, hits.get(item)));
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

/**
 * The full source with open comments embedded as CriticMarkup, for an agent
 * that has no copy of the document. Costs the whole document in tokens.
 *
 * CriticMarkup can't express crossing/nested spans, so overlapping quotes are
 * resolved by acceptance order (first by source position, then longest):
 * identical ranges share one highlight (one comment per item, in id order);
 * anything that merely intersects an already-accepted range is degraded to a
 * trailing note instead of its own `{==...==}`. A located quote that itself
 * contains a CriticMarkup delimiter is degraded the same way, since the
 * delimiter can't be neutralized without altering the document text.
 */
export function formatCriticMarkup(comments, source) {
  const open = comments.items.filter((i) => i.status === 'open');

  const label = (item) =>
    `${item.id} ${item.tag}${item.replace ? ` => "${neutralizeCm(item.replace)}"` : ''}`;
  const noteSuffix = (item) => (item.note ? `: ${neutralizeCm(item.note)}` : '');
  const comment = (item) => `{>>${label(item)}${noteSuffix(item)}<<}`;
  const noteOnly = (item, what) => `{>>${label(item)}${what}${noteSuffix(item)}<<}`;
  const quoted = (text) => ` ~"${neutralizeCm(text)}"`;

  const lineStart = (line) => {
    let at = 0;
    for (let n = 1; n < line; n++) at = source.indexOf('\n', at) + 1;
    return at;
  };

  // Events are applied in a single left-to-right pass over `source` (sorted,
  // then walked once), so inserting at one offset never shifts another.
  const events = []; // { at, order, id, text }
  const pushEvent = (at, order, item, text) => events.push({ at, order, id: item.id, text });

  const exact = []; // candidate highlight spans: { item, start, end }
  for (const item of open) {
    if (!item.anchor) continue;
    const hit = locate(source, item.anchor);
    if (!hit) continue;
    if (hit.start == null) {
      const what = item.anchor.block
        ? ` [${neutralizeCm(item.anchor.block.label)}]`
        : quoted(item.anchor.quote);
      // Order 0: a line-start/point note must precede a highlight opening
      // (order 1) at the same offset, never land inside it.
      pushEvent(lineStart(hit.lines[0]), 0, item, noteOnly(item, what));
      continue;
    }
    const quote = source.slice(hit.start, hit.end);
    if (hasCmDelimiter(quote)) {
      pushEvent(hit.start, 0, item, noteOnly(item, quoted(quote)));
      continue;
    }
    exact.push({ item, start: hit.start, end: hit.end });
  }

  // Longest-first within a start so a containing span is accepted before the
  // quotes nested inside it are considered.
  exact.sort((a, b) => a.start - b.start || b.end - a.end || a.item.id.localeCompare(b.item.id));
  const groups = []; // accepted, mutually non-overlapping spans
  for (const cand of exact) {
    const identical = groups.find((g) => g.start === cand.start && g.end === cand.end);
    if (identical) {
      identical.comments.push(cand.item);
      continue;
    }
    const overlapping = groups.find((g) => cand.start < g.end && g.start < cand.end);
    if (overlapping) {
      overlapping.degraded.push(cand);
      continue;
    }
    groups.push({ start: cand.start, end: cand.end, comments: [cand.item], degraded: [] });
  }
  for (const g of groups) {
    pushEvent(g.start, 1, g.comments[0], '{==');
    const trailing = g.degraded
      .map((d) => noteOnly(d.item, quoted(source.slice(d.start, d.end))))
      .join('');
    pushEvent(g.end, 2, g.comments[0], `==}${g.comments.map(comment).join('')}${trailing}`);
  }

  events.sort((a, b) => a.at - b.at || a.order - b.order || a.id.localeCompare(b.id));
  const parts = [];
  let cursor = 0;
  for (const e of events) {
    parts.push(source.slice(cursor, e.at), e.text);
    cursor = e.at;
  }
  parts.push(source.slice(cursor));
  const out = parts.join('');

  const general = open.filter((i) => i.tag === 'general' && i.note);
  const generalHead = general.map((g) => `{>>general: ${neutralizeCm(g.note)}<<}\n`).join('');

  // Their original anchor is gone by definition, so print the recorded quote
  // (not a resolved location) as an instruction to restore it.
  const violated = comments.items.filter((i) => i.status === 'violated');
  const violatedHead = violated
    .map((v) => {
      const ln = (v.resolvedLines || v.anchor.lines)[0];
      return `{>>${v.id} ${v.tag} VIOLATED — restore exactly: "${neutralizeCm(v.anchor.quote)}" (near L${ln})<<}\n`;
    })
    .join('');

  return generalHead + violatedHead + out;
}
