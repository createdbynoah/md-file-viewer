import { describe, it, expect } from 'vitest';
import { layoutFor, keyboardInset, summarize, summaryLabel, triageLabel } from './review-layout.js';

describe('layoutFor', () => {
  it('uses the app breakpoints', () => {
    expect(layoutFor(1440)).toBe('rail');
    expect(layoutFor(1024)).toBe('rail');
    expect(layoutFor(1023)).toBe('drawer');
    expect(layoutFor(768)).toBe('drawer');
    expect(layoutFor(767)).toBe('sheet');
    expect(layoutFor(375)).toBe('sheet');
  });
});

describe('keyboardInset', () => {
  it('is zero with no keyboard', () => {
    expect(keyboardInset({ innerHeight: 800, vvHeight: 800, vvOffsetTop: 0 })).toBe(0);
  });
  it('is the covered height when the keyboard is up', () => {
    expect(keyboardInset({ innerHeight: 800, vvHeight: 460.4, vvOffsetTop: 0 })).toBe(340);
  });
  it('accounts for the visual viewport being scrolled within the layout viewport', () => {
    expect(keyboardInset({ innerHeight: 800, vvHeight: 460, vvOffsetTop: 100 })).toBe(240);
  });
  it('never goes negative (pinch zoom, overscroll)', () => {
    expect(keyboardInset({ innerHeight: 800, vvHeight: 820, vvOffsetTop: 0 })).toBe(0);
  });
  it('is zero while pinch-zoomed in, where the shrunken viewport is not a keyboard', () => {
    expect(keyboardInset({ innerHeight: 800, vvHeight: 400, vvOffsetTop: 0, scale: 2 })).toBe(0);
  });
  it('still reports the keyboard at the unzoomed scale', () => {
    expect(keyboardInset({ innerHeight: 800, vvHeight: 460, vvOffsetTop: 0, scale: 1 })).toBe(340);
    expect(keyboardInset({ innerHeight: 800, vvHeight: 460, vvOffsetTop: 0, scale: 1.005 })).toBe(
      340
    );
  });
});

describe('summarize / summaryLabel', () => {
  const items = [
    { tag: 'fix', status: 'open' },
    { tag: 'q', status: 'open' },
    { tag: 'general', status: 'open' },
    { tag: 'keep', status: 'open' },
    { tag: 'cut', status: 'addressed' },
    { tag: 'keep', status: 'violated' },
  ];
  it('counts open work, keeps and addressed separately', () => {
    expect(summarize(items)).toEqual({ open: 3, keep: 1, addressed: 1, violated: 1 });
  });
  it('labels compactly and omits zero parts', () => {
    expect(summaryLabel({ open: 3, keep: 1, addressed: 1, violated: 0 })).toBe('3 open · 1 keep');
    expect(summaryLabel({ open: 0, keep: 2, addressed: 0, violated: 0 })).toBe('2 keep');
    expect(summaryLabel({ open: 0, keep: 0, addressed: 4, violated: 0 })).toBe('All addressed');
    expect(summaryLabel({ open: 0, keep: 0, addressed: 0, violated: 0 })).toBe('No comments yet');
  });
  it('counts violated keeps on their own and leads the label with them', () => {
    expect(summarize(items)).toEqual({ open: 3, keep: 1, addressed: 1, violated: 1 });
    expect(summaryLabel({ open: 3, keep: 1, addressed: 1, violated: 1 })).toBe(
      '1 violated · 3 open · 1 keep'
    );
    expect(summaryLabel({ open: 3, keep: 1, addressed: 1, violated: 0 })).toBe('3 open · 1 keep');
  });
});

describe('triageLabel', () => {
  it('summarizes a round and omits zero parts', () => {
    expect(
      triageLabel({ rev: 3, round: 2, addressed: 4, carried: 1, violated: 1, restored: 0 })
    ).toBe('Round 2: 4 addressed · 1 carried over · 1 keep violated');
    expect(
      triageLabel({ rev: 3, round: 3, addressed: 0, carried: 0, violated: 0, restored: 1 })
    ).toBe('Round 3: 1 keep restored');
    expect(
      triageLabel({ rev: 3, round: 2, addressed: 0, carried: 0, violated: 0, restored: 0 })
    ).toBe('Round 2: nothing changed for your comments');
  });
});
