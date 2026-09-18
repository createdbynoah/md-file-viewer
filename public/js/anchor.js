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

/**
 * Offsets at which each 1-based line starts. Built once per `locate` call so
 * line numbers cost a binary search instead of a scan from 0 (a short quote in
 * a 2 MB note can have thousands of hits).
 * @returns {number[]} `starts[n]` is the offset of line `n + 1`
 */
function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 1-based line containing `offset`, via binary search over `lineStarts`. */
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Text of the 1-based inclusive line range and its offset in `source`. */
export function sliceLines(source, [startLine, endLine]) {
  const all = source.split('\n');
  let offset = 0;
  for (let i = 0; i < startLine - 1; i++) offset += all[i].length + 1;
  return { text: all.slice(startLine - 1, endLine).join('\n'), offset };
}

// markdown-it runs with `typographer: true`, so the RENDERED text holds ’ “ ” –
// — … where the SOURCE holds ' " -- --- ... (and vice versa when we search the
// rendered DOM for a source quote). Each pair below matches either form from
// either side, so the match stays exact — this is equivalence, not fuzziness.
// Longest sequences first: `---` must win over `--`.
/** @type {[RegExp, string][]} */
const TYPO = [
  [/^(?:---|—)/, '(?:---|—)'],
  [/^(?:--|–)/, '(?:--|–)'],
  [/^(?:\.\.\.|…)/, '(?:\\.\\.\\.|…)'],
  [/^['‘’]/, "['‘’]"],
  [/^["“”]/, '["“”]'],
];

/** Regex source for one whitespace-free word, tolerant of typographic forms. */
function wordPattern(word) {
  let out = '';
  for (let i = 0; i < word.length;) {
    const rest = word.slice(i);
    const hit = TYPO.find(([re]) => re.test(rest));
    if (hit) {
      out += hit[1];
      i += rest.match(hit[0])[0].length;
    } else {
      out += word[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return out;
}

/**
 * Regex matching `quote` with every whitespace run loosened to \s+ and every
 * typographic character matching its ASCII source form (and vice versa).
 */
export function wsRegex(quote) {
  const words = quote.trim().split(/\s+/).map(wordPattern);
  return new RegExp(words.join('\\s+'), 'g');
}

export function findAll(source, quote) {
  const out = [];
  if (!quote) return out;
  for (let i = source.indexOf(quote); i !== -1; i = source.indexOf(quote, i + 1)) out.push(i);
  return out;
}

/**
 * @param {string} source raw markdown
 * @param {[number, number]} lines 1-based inclusive range the selection sits in
 * @param {string} selectedText the rendered text the user selected
 * @param {number} [nth] 0-based occurrence within `lines` (clamped to the last)
 * @returns {Anchor}
 */
export function captureAnchor(source, lines, selectedText, nth = 0) {
  const slice = sliceLines(source, lines);
  const all = selectedText.trim() ? [...slice.text.matchAll(wsRegex(selectedText))] : [];
  const m = all.length ? all[Math.min(Math.max(nth, 0), all.length - 1)] : null;
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
  const starts = lineStarts(source);
  if (anchor.block || anchor.approx) {
    const [s, e] = anchor.lines;
    if (s < 1 || e < s || e > starts.length) return null;
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
  // Decorate-then-pick in one linear pass: scoring and line numbers used to be
  // recomputed inside the sort comparator, which is O(n log n) full-source
  // scans for a common quote in a large note.
  let best = null;
  for (const hit of hits) {
    const score = contextScore(source, hit.start, hit.end, anchor);
    const dist = Math.abs(lineOf(starts, hit.start) - anchor.lines[0]);
    if (!best || score > best.score || (score === best.score && dist < best.dist)) {
      best = { ...hit, score, dist };
    }
    // Nothing can beat full context agreement on the remembered line.
    if (best.score === 4 && best.dist === 0) break;
  }
  const { start, end } = best;
  return { start, end, lines: [lineOf(starts, start), lineOf(starts, end - 1)] };
}

/**
 * 0-based index of the occurrence at `start` among occurrences in the line
 * slice. Counts whitespace- and typography-tolerantly, exactly like the regex
 * `rangeForQuote` uses on the rendered text, so both directions agree.
 */
export function nthInLines(source, lines, start, quote) {
  const slice = sliceLines(source, lines);
  if (!quote.trim()) return 0;
  return [...slice.text.matchAll(wsRegex(quote))].filter((m) => slice.offset + m.index < start)
    .length;
}
