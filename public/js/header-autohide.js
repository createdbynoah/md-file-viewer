// Show/hide decision for the sticky note header: it slides away while the
// reader scrolls down and comes back on a deliberate scroll up. Pure so it can
// be unit-tested; app.js feeds it window.scrollY once per animation frame.

// Downward travel before hiding / upward travel before revealing, in px.
export const HIDE_DELTA = 8;
export const REVEAL_DELTA = 16;

// state: { hidden, anchorY }, where anchorY is the turning point the next
// delta is measured from. stuckAt: scroll offset at or below which the header
// is still in its natural place and must show. locked: something in the header
// is in use (menu, drawer, editor, keyboard focus).
export function nextHeaderState({ hidden, anchorY }, y, { stuckAt, locked }) {
  if (locked || y <= stuckAt) return { hidden: false, anchorY: y };
  if (hidden) {
    if (y >= anchorY) return { hidden, anchorY: y };
    return anchorY - y >= REVEAL_DELTA ? { hidden: false, anchorY: y } : { hidden, anchorY };
  }
  if (y <= anchorY) return { hidden, anchorY: y };
  return y - anchorY >= HIDE_DELTA ? { hidden: true, anchorY: y } : { hidden, anchorY };
}
