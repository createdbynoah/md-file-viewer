import { describe, it, expect } from 'vitest';
import {
  scrollRatio,
  ratioToScrollTop,
  saveScrollRatio,
  loadScrollRatio,
  SCROLL_MAX_ENTRIES,
} from './scroll-memory.js';

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe('scrollRatio', () => {
  it('is scrollTop over the scrollable range', () => {
    expect(scrollRatio({ scrollTop: 250, scrollHeight: 1500, clientHeight: 500 })).toBe(0.25);
  });
  it('is 0 when content does not overflow', () => {
    expect(scrollRatio({ scrollTop: 0, scrollHeight: 400, clientHeight: 500 })).toBe(0);
  });
});

describe('ratioToScrollTop', () => {
  it('maps a ratio back onto the current scrollable range', () => {
    expect(ratioToScrollTop(0.5, { scrollHeight: 2500, clientHeight: 500 })).toBe(1000);
  });
});

describe('save/load', () => {
  it('round-trips a ratio per note id', () => {
    const s = memStorage();
    saveScrollRatio(s, 'a', 0.4, 100);
    expect(loadScrollRatio(s, 'a')).toBe(0.4);
  });
  it('returns null for an unknown id', () => {
    expect(loadScrollRatio(memStorage(), 'nope')).toBeNull();
  });
  it('returns null for a position within 2% of the top', () => {
    const s = memStorage();
    saveScrollRatio(s, 'a', 0.01, 100);
    expect(loadScrollRatio(s, 'a')).toBeNull();
  });
  it('returns null for corrupt stored data', () => {
    const s = memStorage();
    s.setItem('scrollPos:a', '{not json');
    expect(loadScrollRatio(s, 'a')).toBeNull();
  });
  it('prunes the oldest entries beyond the cap', () => {
    const s = memStorage();
    for (let i = 0; i <= SCROLL_MAX_ENTRIES; i++) saveScrollRatio(s, `n${i}`, 0.5, i);
    expect(loadScrollRatio(s, 'n0')).toBeNull();
    expect(loadScrollRatio(s, 'n1')).toBe(0.5);
    expect(loadScrollRatio(s, `n${SCROLL_MAX_ENTRIES}`)).toBe(0.5);
  });
  it('ignores unrelated keys when pruning', () => {
    const s = memStorage();
    s.setItem('theme', 'dark');
    for (let i = 0; i <= SCROLL_MAX_ENTRIES; i++) saveScrollRatio(s, `n${i}`, 0.5, i);
    expect(s.getItem('theme')).toBe('dark');
  });
  it('swallows storage errors on save', () => {
    const s = {
      ...memStorage(),
      setItem() {
        throw new Error('quota');
      },
    };
    expect(() => saveScrollRatio(s, 'a', 0.5, 1)).not.toThrow();
  });
});
