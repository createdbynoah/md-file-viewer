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
  const locate1 = (text) => nearest(newSource, findAll(newSource, text), anchor.lines[0]);

  // The quote itself is captured whitespace-trimmed, so a boundary space next
  // to it lives in prefix/suffix. When a selection deliberately eats that
  // boundary space too (e.g. cutting " trailing clause." including the
  // leading space), the space vanishes from the new source along with the
  // quote, and the literal prefix/suffix no longer matches even though the
  // surviving text plainly shows nothing replaced it. Retry with the
  // boundary whitespace trimmed before giving up.
  let prefix = anchor.prefix;
  let from = prefix ? locate1(prefix) : 0;
  if (prefix && from === -1) {
    const trimmed = prefix.replace(/\s+$/, '');
    if (trimmed && trimmed !== prefix) {
      from = locate1(trimmed);
      if (from !== -1) prefix = trimmed;
    }
  }
  if (from === -1) return null;

  const start = from + prefix.length;
  let suffix = anchor.suffix;
  let end = suffix ? newSource.indexOf(suffix, start) : newSource.length;
  if (suffix && end === -1) {
    const trimmed = suffix.replace(/^\s+/, '');
    if (trimmed && trimmed !== suffix) end = newSource.indexOf(trimmed, start);
  }
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
  const rest = { ...item };
  delete rest.replacedBy;
  delete rest.resolvedLines;
  delete rest.resolvedRev;
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
