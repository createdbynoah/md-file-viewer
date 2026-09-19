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

/**
 * Pixels of the layout viewport's bottom covered by the on-screen keyboard.
 * Pinch-zooming shrinks the visual viewport the same way a keyboard does, so a
 * scale above 1 means the difference is zoom, not a keyboard: report nothing.
 */
export function keyboardInset({ innerHeight, vvHeight, vvOffsetTop, scale = 1 }) {
  if (scale > 1.01) return 0;
  return Math.max(0, Math.round(innerHeight - vvHeight - vvOffsetTop));
}

export function summarize(items) {
  const out = { open: 0, keep: 0, addressed: 0, violated: 0 };
  for (const item of items) {
    if (item.status === 'addressed') out.addressed++;
    else if (item.status === 'violated') out.violated++;
    else if (item.status === 'open') out[item.tag === 'keep' ? 'keep' : 'open']++;
  }
  return out;
}

export function summaryLabel({ open, keep, addressed, violated = 0 }) {
  const parts = [];
  if (violated) parts.push(`${violated} violated`);
  if (open) parts.push(`${open} open`);
  if (keep) parts.push(`${keep} keep`);
  if (parts.length) return parts.join(' · ');
  return addressed ? 'All addressed' : 'No comments yet';
}

/** Banner text for the last triage, e.g. "Round 2: 4 addressed · 1 carried over". */
export function triageLabel({ round, addressed, carried, violated, restored }) {
  const parts = [];
  if (addressed) parts.push(`${addressed} addressed`);
  if (carried) parts.push(`${carried} carried over`);
  if (violated) parts.push(`${violated} keep violated`);
  if (restored) parts.push(`${restored} keep restored`);
  return `Round ${round}: ${parts.length ? parts.join(' · ') : 'nothing changed for your comments'}`;
}
