import { describe, it, expect } from 'vitest';
import { layoutFor, keyboardInset, summarize, summaryLabel } from './review-layout.js';

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
    expect(summarize(items)).toEqual({ open: 3, keep: 1, addressed: 1 });
  });
  it('labels compactly and omits zero parts', () => {
    expect(summaryLabel({ open: 3, keep: 1, addressed: 1 })).toBe('3 open · 1 keep');
    expect(summaryLabel({ open: 0, keep: 2, addressed: 0 })).toBe('2 keep');
    expect(summaryLabel({ open: 0, keep: 0, addressed: 4 })).toBe('All addressed');
    expect(summaryLabel({ open: 0, keep: 0, addressed: 0 })).toBe('No comments yet');
  });
});
