// Re-checks every review comment against a new revision. Pure and shared: the
// worker runs it inside PUT /api/files/:id, the UAT seed uses it to build a
// round-2 scenario, and the tests drive it directly.
import {
  anchorAt,
  blockAnchor,
  contextScore,
  findAll,
  lineOf,
  lineTable,
  locate,
  sliceLines,
  wsRegex,
} from './anchor.js';

const MAX_REPLACED = 2000;

/**
 * Drop inline markdown markers so a rendered quote can be matched. Never
 * touches newlines. `_`/`__` are emphasis delimiters only when NOT
 * intra-word — CommonMark disables underscore emphasis inside a word, so an
 * identifier like `config_max_retries` must survive stripping unchanged
 * (only a genuine `_emph_` delimiter pair is removed).
 */
export function stripInline(text) {
  const noLinks = text.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1');
  const noUnderscore = noLinks.replace(/_{1,2}/g, (m, offset, str) => {
    const isWord = (c) => c !== undefined && /\w/.test(c);
    return isWord(str[offset - 1]) && isWord(str[offset + m.length]) ? m : '';
  });
  return noUnderscore.replace(/(\*\*|~~|\*|`)/g, '');
}

function clampLines(maxLines, [s, e]) {
  const start = Math.min(Math.max(s, 1), maxLines);
  return [start, Math.min(Math.max(e, start), maxLines)];
}

function linesBlock(maxLines, lines) {
  const [s, e] = clampLines(maxLines, lines);
  return blockAnchor([s, e], 'lines', `lines ${s}–${e}`);
}

/** Regenerate a block anchor's `lines` (and, for a `lines`-kind block, its label). */
function withBlockLines(anchor, s, e) {
  const block =
    anchor.block.kind === 'lines' ? { kind: 'lines', label: `lines ${s}–${e}` } : anchor.block;
  return { ...anchor, lines: [s, e], block };
}

/** The item in `items` whose `keyFn(item)` line is closest to `line`, in one pass. */
function pickNearest(starts, items, line, keyFn) {
  let best = null;
  let bestDist = Infinity;
  for (const it of items) {
    const dist = Math.abs(lineOf(starts, keyFn(it)) - line);
    if (dist < bestDist) {
      bestDist = dist;
      best = it;
    }
  }
  return best;
}

/** Offset in `offsets` nearest to `line`, via a `lineTable`, or -1 when empty. */
function nearest(starts, offsets, line) {
  const best = pickNearest(starts, offsets, line, (x) => x);
  return best === null ? -1 : best;
}

/**
 * Every ws/typography-tolerant match of `quote` in `text`, or `[]` when
 * `quote` is empty (or whitespace-only). `wsRegex('')` builds an empty
 * pattern that matches at every offset — O(text length) hits, each costing a
 * line lookup — so every caller must route through here instead of calling
 * `wsRegex` directly on a quote that might have stripped down to nothing.
 */
function matchesFor(text, quote) {
  if (!quote.trim()) return [];
  return [...text.matchAll(wsRegex(quote))];
}

// Context lengths tried, longest first, when pinning a replacement span — a
// neighboring edit (on the same or an adjacent line) can fall inside the
// full 32-char context without touching the quote itself, so a shorter,
// closer-to-the-quote slice is retried before giving up. The paired
// (prefix, suffix) lengths are tried together, never mixed.
const SPAN_CONTEXT_TIERS = [Infinity, 16, 8];

/** Last (for the prefix) or first (for the suffix) `len` chars of `trimmed`, or all of it when shorter. */
function contextTier(trimmed, len, fromEnd) {
  if (trimmed.length <= len) return trimmed;
  return fromEnd ? trimmed.slice(-len) : trimmed.slice(0, len);
}

/** One (prefix, suffix) tier attempt for `replacedSpan`; see its doc comment. */
function pinSpan(newSource, anchor, starts, prefix, suffix) {
  let start;
  if (anchor.prefix === '') {
    start = 0;
  } else {
    const at = nearest(starts, findAll(newSource, prefix), anchor.lines[0]);
    if (at === -1) return null;
    start = at + prefix.length;
  }

  let end;
  if (anchor.suffix === '') {
    end = newSource.length;
  } else {
    const idx = newSource.indexOf(suffix, start);
    if (idx === -1) return null;
    end = idx;
  }
  if (end < start) end = start;
  if (end - start > MAX_REPLACED) return null;

  const raw = newSource.slice(start, end);
  const text = raw.trim();
  if (text === '') {
    const line = lineOf(starts, start);
    return { text: '', lines: [line, line] };
  }
  const leadingWs = raw.length - raw.trimStart().length;
  const trailingWs = raw.length - raw.trimEnd().length;
  const textStart = start + leadingWs;
  const textEnd = end - trailingWs;
  return {
    text,
    lines: [lineOf(starts, textStart), lineOf(starts, Math.max(textStart, textEnd - 1))],
  };
}

/**
 * The new text sitting between an anchor's surviving prefix and suffix, or
 * null when neither side can be pinned down in `newSource` at any context
 * length. The quote itself is captured whitespace-trimmed, so a boundary
 * space next to it lives in `prefix`/`suffix`; search on the trimmed
 * boundary (nearest the old line for the prefix). A side that was
 * ORIGINALLY empty (the quote sat at a document boundary) always stays that
 * boundary — it is never searched for, at any tier.
 *
 * A neighboring edit can land inside the full 32-char context without
 * touching the quote itself (an edit on the same line just past the quote,
 * or on the very next line, both fall inside a short quote's captured
 * suffix). So this retries with a shorter context — keeping the END of the
 * prefix and the START of the suffix, closest to the quote — before giving
 * up: full context, then the last/first 16 chars, then 8. `contextTier`
 * already no-ops when a side is shorter than the tier's length, so a short
 * side is naturally reused unchanged across tiers (never padded, never
 * searched-for twice with identical input — tiers whose (prefix, suffix)
 * pair is unchanged from the previous attempt are skipped). This only
 * changes what a FOUND replacement is reported as; it never changes whether
 * an item counts as found vs. gone (that's decided by `follow`/`locate`
 * elsewhere in this module, which never call this at a shortened tier).
 *
 * Shortening trades precision for reach: with a short, repeated substring
 * (e.g. an 8-char tier that lands on common text), the first matching
 * occurrence AFTER the prefix wins even if a "more correct" one sits
 * further away — the existing, documented behavior of a literal
 * `indexOf`/`findAll` search, just reachable at a shorter tier now.
 *
 * `lines` are measured from the TRIMMED replacement text (its first to its
 * last non-whitespace character), not from the raw start/end — the raw span
 * can include boundary newlines from the prefix/suffix seam (e.g. a
 * paragraph break) that would otherwise inflate the reported range past
 * where the replacement text actually sits. A genuine full deletion still
 * yields `text: ''` with both `lines` entries set to the (single, valid)
 * line the deletion sits on.
 * @param {number[]} [starts] a `lineTable(newSource)` result, when the
 *   caller already has one.
 */
export function replacedSpan(newSource, anchor, starts = lineTable(newSource)) {
  if (!anchor.prefix && !anchor.suffix) return null;

  const prefixTrimmed = anchor.prefix.replace(/\s+$/, '');
  const suffixTrimmed = anchor.suffix.replace(/^\s+/, '');
  // A side that was present but whitespace-only has no real content to pin
  // against, at any tier — the whole call is doomed.
  if (anchor.prefix !== '' && !prefixTrimmed) return null;
  if (anchor.suffix !== '' && !suffixTrimmed) return null;

  let lastPrefix = null;
  let lastSuffix = null;
  for (const len of SPAN_CONTEXT_TIERS) {
    const prefix = anchor.prefix === '' ? '' : contextTier(prefixTrimmed, len, true);
    const suffix = anchor.suffix === '' ? '' : contextTier(suffixTrimmed, len, false);
    if (prefix === lastPrefix && suffix === lastSuffix) continue; // identical to an attempt already made
    lastPrefix = prefix;
    lastSuffix = suffix;
    const span = pinSpan(newSource, anchor, starts, prefix, suffix);
    if (span) return span;
  }
  return null;
}

// Shortened context tier used when the full stored prefix/suffix no longer
// matches: the 8 characters closest to the quote on each side. Evidence this
// short is weak, so when BOTH sides were captured it must agree on both — a
// lone 8-char match on one side is exactly what an unrelated twin elsewhere
// in the note tends to produce by accident.
const SHORT_CONTEXT = 8;

/**
 * How strongly the text around [start, end) agrees with the anchor's stored
 * context: the full literal prefix/suffix first (2 per side, as
 * `contextScore`), and only if neither side survives, the last/first
 * `SHORT_CONTEXT` characters (1 per side, both sides required when both were
 * captured). A full match therefore always outranks a short one.
 */
function contextAgreement(source, start, end, anchor) {
  const full = contextScore(source, start, end, anchor);
  if (full > 0) return full;
  const pre = anchor.prefix.slice(-SHORT_CONTEXT);
  const post = anchor.suffix.slice(0, SHORT_CONTEXT);
  const preOk = pre !== '' && source.slice(start - pre.length, start) === pre;
  const postOk = post !== '' && source.slice(end, end + post.length) === post;
  if (pre && post) return preOk && postOk ? 1 : 0;
  return preOk || postOk ? 1 : 0;
}

/**
 * The hit to re-anchor to when the quote is AMBIGUOUS — it occurred more than
 * once in the old source, or does in the new one. Picking by line distance
 * alone would let a surviving twin mask an edit to the occurrence the
 * reviewer actually commented on (a fix would look "carried" onto the wrong
 * sentence; a violated keep would look untouched), so a hit must carry some
 * surviving context to be eligible: best agreement wins, ties broken by
 * distance from the remembered line. A legacy anchor with no stored context
 * at all has nothing to disambiguate with, so it falls back to the nearest
 * hit rather than being declared gone.
 * @returns {{ start: number, end: number } | null}
 */
function pickAmbiguous(source, starts, anchor, hits) {
  if (!anchor.prefix && !anchor.suffix) {
    return pickNearest(starts, hits, anchor.lines[0], (h) => h.start);
  }
  let best = null;
  for (const hit of hits) {
    const score = contextAgreement(source, hit.start, hit.end, anchor);
    if (score === 0) continue;
    const dist = Math.abs(lineOf(starts, hit.start) - anchor.lines[0]);
    if (!best || score > best.score || (score === best.score && dist < best.dist)) {
      best = { ...hit, score, dist };
    }
  }
  return best;
}

/**
 * Follow a quote anchor into the new source. `keep` hits must be
 * byte-identical (no whitespace/typographic tolerance); for every other tag
 * the tolerant forms are accepted, but only when there is no literal hit at
 * all.
 *
 * Duplicates are the interesting case, and the rule is shared by both: if the
 * quote occurred more than once in the OLD source, or occurs more than once
 * in the new one, the surviving hit must carry matching context
 * (`pickAmbiguous`) — otherwise the anchor is gone. A quote that was unique
 * in the old source and survives exactly once is accepted as-is, context or
 * not. The old-source scan is only paid for in the one case that can't be
 * decided without it (a single hit with no surviving context).
 */
function followQuote(oldSource, newSource, newStarts, a, keep) {
  let hits = findAll(newSource, a.quote).map((start) => ({
    start,
    end: start + a.quote.length,
  }));
  if (!keep && !hits.length) {
    hits = matchesFor(newSource, a.quote).map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
    }));
  }
  if (!hits.length) return null;
  const found = ({ start, end }) => ({ anchor: anchorAt(newSource, start, end, newStarts) });
  if (hits.length === 1) {
    const only = hits[0];
    if (!a.prefix && !a.suffix) return found(only);
    if (contextAgreement(newSource, only.start, only.end, a) > 0) return found(only);
    if (findAll(oldSource, a.quote).length <= 1) return found(only);
    return null; // a twin existed before; this lone survivor isn't it
  }
  const best = pickAmbiguous(newSource, newStarts, a, hits);
  return best ? found(best) : null;
}

/**
 * Where an anchor sits in the new source: `{ anchor }` when found, else
 * null. `newStarts` is `lineTable(newSource)`, built once per `triage()`
 * call. `strippedRef()` lazily builds (and memoizes, for the whole
 * `triage()` call) a `stripInline(newSource)` copy plus its own line table,
 * the first time an approx anchor needs it.
 */
function follow(oldSource, newSource, item, newStarts, strippedRef) {
  const a = item.anchor;
  if (a.block) {
    const oldText = sliceLines(oldSource, a.lines).text;
    const span = a.lines[1] - a.lines[0];
    if (oldText.trim() === '') {
      // Nothing to compare a blank block against — findAll('') would return
      // no hits and falsely say it's gone. Treat it as still there, at its
      // old position clamped to the new source.
      const [s, e] = clampLines(newStarts.length, a.lines);
      return { anchor: withBlockLines(a, s, e) };
    }
    const hits = findAll(newSource, oldText);
    const atLineStart = hits.filter((i) => i === 0 || newSource[i - 1] === '\n');
    const at = nearest(newStarts, atLineStart.length ? atLineStart : hits, a.lines[0]);
    if (at === -1) return null;
    const first = lineOf(newStarts, at);
    const last = Math.min(first + span, newStarts.length);
    return { anchor: withBlockLines(a, first, last) };
  }
  if (a.approx) {
    const strippedQuote = stripInline(a.quote);
    if (!strippedQuote.trim()) {
      // The quote was pure markdown markers (e.g. "***"): there's nothing
      // left to compare, so don't search — an empty pattern would match at
      // every offset (O(source length), and yield an invalid zero-width
      // range). Treat it as still there, at its old line range, clamped to
      // the new source — same policy as a blank block (see the F3 branch).
      const [s, e] = clampLines(newStarts.length, a.lines);
      return { anchor: { ...a, lines: [s, e] } };
    }
    const { stripped, starts: strippedStarts } = strippedRef();
    const hits = matchesFor(stripped, strippedQuote);
    if (!hits.length) return null;
    const m = pickNearest(strippedStarts, hits, a.lines[0], (h) => h.index);
    return {
      anchor: {
        ...a,
        lines: [lineOf(strippedStarts, m.index), lineOf(strippedStarts, m.index + m[0].length - 1)],
      },
    };
  }
  return followQuote(oldSource, newSource, newStarts, a, item.tag === 'keep');
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
  // Built once per call and threaded through every re-anchor below, instead
  // of re-deriving a line table (or, for an approx anchor, a stripped copy
  // of the whole note) per comment — see the F1 perf test.
  const newStarts = lineTable(newSource);
  let strippedCache = null;
  const strippedRef = () => {
    if (!strippedCache) {
      const stripped = stripInline(newSource);
      strippedCache = { stripped, starts: lineTable(stripped) };
    }
    return strippedCache;
  };

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
    const found = follow(oldSource, newSource, item, newStarts, strippedRef);

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
      return { ...item, anchor: linesBlock(newStarts.length, item.anchor.lines), rev: newRev };
    }
    const span =
      item.anchor.block || item.anchor.approx
        ? null
        : replacedSpan(newSource, item.anchor, newStarts);
    const resolved = {
      ...item,
      rev: newRev,
      resolvedRev: newRev,
      resolvedLines: span ? span.lines : clampLines(newStarts.length, item.anchor.lines),
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

/**
 * Anchor to use when an addressed comment is reopened against `source`.
 * @param {number[]} [starts] a `lineTable(source)` result, when the caller
 *   already has one.
 */
export function reopenAnchor(source, item, starts = lineTable(source)) {
  if (locate(source, item.anchor)) return item.anchor;
  if (item.replacedBy) {
    const at = nearest(
      starts,
      findAll(source, item.replacedBy),
      (item.resolvedLines || item.anchor.lines)[0]
    );
    if (at !== -1) return anchorAt(source, at, at + item.replacedBy.length, starts);
  }
  return linesBlock(starts.length, item.resolvedLines || item.anchor.lines);
}
