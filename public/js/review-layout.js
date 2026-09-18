// Pure layout decisions for review mode, kept out of comments-ui.js so they can
// be unit-tested: which presentation a viewport gets, how far the on-screen
// keyboard pushes the bottom sheet up, and the review bar's summary text.

export const RAIL_MIN_WIDTH = 1024;
export const DRAWER_MIN_WIDTH = 768;

/** rail: margin cards · drawer: list in the sticky header · sheet: bottom sheets. */
export function layoutFor(width) {
  if (width >= RAIL_MIN_WIDTH) return 'rail';
  return width >= DRAWER_MIN_WIDTH ? 'drawer' : 'sheet';
}

/** Pixels of the layout viewport's bottom covered by the on-screen keyboard. */
export function keyboardInset({ innerHeight, vvHeight, vvOffsetTop }) {
  return Math.max(0, Math.round(innerHeight - vvHeight - vvOffsetTop));
}

export function summarize(items) {
  const out = { open: 0, keep: 0, addressed: 0 };
  for (const item of items) {
    if (item.status === 'addressed') out.addressed++;
    else if (item.status === 'open') out[item.tag === 'keep' ? 'keep' : 'open']++;
  }
  return out;
}

export function summaryLabel({ open, keep, addressed }) {
  const parts = [];
  if (open) parts.push(`${open} open`);
  if (keep) parts.push(`${keep} keep`);
  if (parts.length) return parts.join(' · ');
  return addressed ? 'All addressed' : 'No comments yet';
}
