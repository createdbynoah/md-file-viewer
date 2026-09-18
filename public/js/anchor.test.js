import { describe, it, expect } from 'vitest';
import {
  lineAt,
  sliceLines,
  findAll,
  captureAnchor,
  blockAnchor,
  locate,
  nthInLines,
  wsRegex,
  anchorAt,
} from './anchor.js';

const SRC = [
  '# Rollout plan', // 1
  '', // 2
  'We will ship to all customers in a single release after the beta ends.', // 3
  'Rollback is a **one-line** flag flip.', // 4
  '', // 5
  'The beta is small. The beta is closed.', // 6
].join('\n');

describe('line math', () => {
  it('lineAt is 1-based', () => {
    expect(lineAt(SRC, 0)).toBe(1);
    expect(lineAt(SRC, SRC.indexOf('We will'))).toBe(3);
  });
  it('sliceLines returns inclusive text and its offset', () => {
    const s = sliceLines(SRC, [3, 4]);
    expect(s.text.startsWith('We will')).toBe(true);
    expect(s.text.endsWith('flag flip.')).toBe(true);
    expect(s.offset).toBe(SRC.indexOf('We will'));
  });
});

describe('captureAnchor', () => {
  it('captures an exact source quote with context', () => {
    const a = captureAnchor(SRC, [3, 3], 'all customers in a single release');
    expect(a.approx).toBe(false);
    expect(a.quote).toBe('all customers in a single release');
    expect(a.lines).toEqual([3, 3]);
    expect(a.prefix.endsWith('ship to ')).toBe(true);
    expect(a.suffix.startsWith(' after the beta')).toBe(true);
    expect(a.prefix.length).toBeLessThanOrEqual(32);
  });
  it('matches across a soft line break and stores the real source substring', () => {
    const a = captureAnchor(SRC, [3, 4], 'beta ends. Rollback is');
    expect(a.approx).toBe(false);
    expect(a.quote).toBe('beta ends.\nRollback is');
    expect(a.lines).toEqual([3, 4]);
  });
  it('captures the nth occurrence inside the slice, with its own context', () => {
    const second = SRC.lastIndexOf('The beta');
    const a = captureAnchor(SRC, [6, 6], 'The beta', 1);
    expect(a.approx).toBe(false);
    expect(a.quote).toBe('The beta');
    expect(a.prefix).toBe(SRC.slice(Math.max(0, second - 32), second));
    expect(a.prefix.endsWith('is small. ')).toBe(true);
    expect(a.suffix.startsWith(' is closed.')).toBe(true);
    // the first occurrence is still the default, and nth clamps to the last
    expect(captureAnchor(SRC, [6, 6], 'The beta').suffix.startsWith(' is small.')).toBe(true);
    expect(captureAnchor(SRC, [6, 6], 'The beta', 9).prefix).toBe(a.prefix);
  });
  it('captures typographic selections exactly from their ASCII source', () => {
    const src = 'We don\'t "ship" on Fridays -- ever... really.';
    const a = captureAnchor(src, [1, 1], 'don’t “ship” on Fridays – ever…');
    expect(a.approx).toBe(false);
    expect(a.quote).toBe('don\'t "ship" on Fridays -- ever...');
    expect(src.slice(src.indexOf(a.quote), src.indexOf(a.quote) + a.quote.length)).toBe(a.quote);
  });
  it('falls back to approx when the selection crosses inline formatting', () => {
    const a = captureAnchor(SRC, [4, 4], 'a one-line flag');
    expect(a.approx).toBe(true);
    expect(a.quote).toBe('a one-line flag');
    expect(a.lines).toEqual([4, 4]);
    expect(a.prefix).toBe('');
  });
});

describe('locate', () => {
  it('finds a unique exact quote', () => {
    const a = captureAnchor(SRC, [3, 3], 'single release');
    const hit = locate(SRC, a);
    expect(SRC.slice(hit.start, hit.end)).toBe('single release');
    expect(hit.lines).toEqual([3, 3]);
  });
  it('disambiguates duplicates by prefix/suffix', () => {
    const second = SRC.lastIndexOf('The beta');
    const a = captureAnchor(SRC, [6, 6], 'The beta');
    // captureAnchor takes the first hit in the slice; rebuild for the second.
    const b = {
      ...a,
      prefix: SRC.slice(second - 32, second),
      suffix: SRC.slice(second + 8, second + 40),
    };
    expect(locate(SRC, b).start).toBe(second);
  });
  it('follows the quote when lines shift', () => {
    const a = captureAnchor(SRC, [3, 3], 'single release');
    const moved = 'intro\n\n' + SRC;
    expect(locate(moved, a).lines).toEqual([5, 5]);
  });
  it('returns null when the quote is gone', () => {
    const a = captureAnchor(SRC, [3, 3], 'single release');
    expect(locate(SRC.replace('single release', 'staged rollout'), a)).toBeNull();
  });
  it('picks the context-matched hit in a source with thousands of occurrences', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `row ${i}: the flag is on.`);
    lines[1500] = 'unique marker: the flag is on. tail marker';
    const big = lines.join('\n');
    const at = big.indexOf('the flag', big.indexOf('unique marker'));
    const anchor = {
      quote: 'the flag',
      approx: false,
      prefix: big.slice(at - 32, at),
      suffix: big.slice(at + 8, at + 40),
      lines: [1, 1],
    };
    const started = Date.now();
    const hit = locate(big, anchor);
    expect(hit.start).toBe(at);
    expect(hit.lines).toEqual([1501, 1501]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('approx and block anchors resolve by line range only', () => {
    const approx = captureAnchor(SRC, [4, 4], 'a one-line flag');
    expect(locate(SRC, approx)).toEqual({ start: null, end: null, lines: [4, 4] });
    expect(locate(SRC, blockAnchor([3, 4], 'paragraph', 'paragraph "We will ship"'))).toEqual({
      start: null,
      end: null,
      lines: [3, 4],
    });
    expect(locate(SRC, blockAnchor([40, 41], 'paragraph', 'x'))).toBeNull();
  });
});

describe('nthInLines / findAll', () => {
  it('counts occurrences before the hit inside the slice', () => {
    const second = SRC.lastIndexOf('The beta');
    expect(findAll(SRC, 'The beta')).toHaveLength(2);
    expect(nthInLines(SRC, [6, 6], second, 'The beta')).toBe(1);
  });
  it('counts whitespace- and typography-tolerantly, like rangeForQuote does', () => {
    const src = 'a b\nthe  beta and the beta again';
    // the source quote has a newline where the rendered text has a space
    expect(nthInLines(src, [1, 2], src.lastIndexOf('the beta'), 'the beta')).toBe(1);
    const typo = "it's fine. it's fine.";
    expect(nthInLines(typo, [1, 1], typo.lastIndexOf("it's"), 'it’s')).toBe(1);
  });
});

describe('wsRegex', () => {
  it('matches in both directions across typographic equivalents', () => {
    const rendered = 'We don’t “ship” on Fridays – ever… really.';
    const source = 'We don\'t "ship" on Fridays -- ever... really.';
    // source quote → rendered text (what rangeForQuote needs)
    expect(rendered.match(wsRegex('don\'t "ship" on Fridays -- ever...'))[0]).toBe(
      'don’t “ship” on Fridays – ever…'
    );
    // rendered selection → source text (what captureAnchor needs)
    expect(source.match(wsRegex('don’t “ship” on Fridays – ever…'))[0]).toBe(
      'don\'t "ship" on Fridays -- ever...'
    );
    expect('an em — dash'.match(wsRegex('em --- dash'))[0]).toBe('em — dash');
  });
});

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
