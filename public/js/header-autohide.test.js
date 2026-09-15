import { describe, it, expect } from 'vitest';
import { nextHeaderState, HIDE_DELTA, REVEAL_DELTA } from './header-autohide.js';

const opts = { stuckAt: 100, locked: false };
const shown = (anchorY) => ({ hidden: false, anchorY });
const hidden = (anchorY) => ({ hidden: true, anchorY });

describe('nextHeaderState', () => {
  it('stays shown before the header is stuck, however far it moved', () => {
    expect(nextHeaderState(shown(0), 100, opts)).toEqual(shown(100));
  });
  it('hides once scrolled down past the stuck point by the hide delta', () => {
    expect(nextHeaderState(shown(200), 200 + HIDE_DELTA, opts)).toEqual(hidden(200 + HIDE_DELTA));
  });
  it('ignores downward jitter smaller than the hide delta', () => {
    expect(nextHeaderState(shown(200), 200 + HIDE_DELTA - 1, opts)).toEqual(shown(200));
  });
  it('hides on a jump from the top straight into the note (scroll restore)', () => {
    expect(nextHeaderState(shown(0), 4000, opts).hidden).toBe(true);
  });
  it('tracks the lowest point while hidden', () => {
    expect(nextHeaderState(hidden(500), 900, opts)).toEqual(hidden(900));
  });
  it('reveals after scrolling up by the reveal delta from the lowest point', () => {
    expect(nextHeaderState(hidden(900), 900 - REVEAL_DELTA, opts)).toEqual(
      shown(900 - REVEAL_DELTA)
    );
  });
  it('stays hidden on upward jitter smaller than the reveal delta', () => {
    expect(nextHeaderState(hidden(900), 900 - REVEAL_DELTA + 1, opts)).toEqual(hidden(900));
  });
  it('tracks the highest point while shown so a later scroll down is measured from there', () => {
    expect(nextHeaderState(shown(900), 700, opts)).toEqual(shown(700));
  });
  it('shows when scrolled back to the stuck point', () => {
    expect(nextHeaderState(hidden(900), 100, opts)).toEqual(shown(100));
  });
  it('stays shown while locked', () => {
    expect(nextHeaderState(shown(200), 2000, { ...opts, locked: true })).toEqual(shown(2000));
    expect(nextHeaderState(hidden(900), 2000, { ...opts, locked: true })).toEqual(shown(2000));
  });
});
