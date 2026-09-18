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
