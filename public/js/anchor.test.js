import { describe, it, expect } from 'vitest';
import {
  lineAt,
  sliceLines,
  findAll,
  captureAnchor,
  blockAnchor,
  locate,
  nthInLines,
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
});
