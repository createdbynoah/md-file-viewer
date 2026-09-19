// Turns a note's comments into the compact plain-text block handed to an agent.
// Pure; used by the Copy feedback button now and by GET /feedback later.
import { findAll, locate } from './anchor.js';

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
