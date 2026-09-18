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
