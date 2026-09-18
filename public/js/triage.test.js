import { describe, it, expect } from 'vitest';
import { captureAnchor, blockAnchor } from './anchor.js';
import { triage, reopenAnchor, replacedSpan, stripInline } from './triage.js';

const V1 = [
  '# Rollout plan', // 1
  '', // 2
  'We will ship to all customers in a single release after the beta ends.', // 3
  'Rollback is a **one-line** flag flip.', // 4
  '', // 5
  '## Costs', // 6
  '', // 7
  '| Item | Monthly |', // 8
  '| --- | --- |', // 9
  '| Workers | $5 |', // 10
  '', // 11
  'Latency target: p95 under 200 ms. We launch soon.', // 12
].join('\n');

const item = (id, tag, anchor, over = {}) => ({
  id,
  tag,
  note: 'n',
  anchor,
  rev: 0,
  status: 'open',
  carried: 0,
  authorId: 'u',
  createdAt: 't',
  ...over,
});
const exact = (lines, text) => captureAnchor(V1, lines, text);
const base = (items) => ({ nextId: 20, round: 1, items });
const byId = (result, id) => result.comments.items.find((i) => i.id === id);

describe('triage — exact anchors', () => {
  it('addresses a fix whose quote changed and captures what replaced it', () => {
    const c = base([item('c1', 'fix', exact([3, 3], 'all customers in a single release'))]);
    const v2 = V1.replace('all customers in a single release', 'customers in three stages');
    const r = triage(c, V1, v2, 1);
    expect(byId(r, 'c1')).toMatchObject({
      status: 'addressed',
      resolvedRev: 1,
      replacedBy: 'customers in three stages',
      resolvedLines: [3, 3],
      rev: 1,
    });
    expect(r.summary).toEqual({
      rev: 1,
      round: 2,
      addressed: 1,
      carried: 0,
      violated: 0,
      restored: 0,
    });
    expect(r.comments.round).toBe(2);
    expect(r.comments.lastTriage).toEqual(r.summary);
    expect(c.items[0].status).toBe('open'); // input untouched
  });

  it('carries an unchanged fix and follows it to its new lines', () => {
    const c = base([item('c2', 'fix', exact([12, 12], 'soon'))]);
    const r = triage(c, V1, 'Intro line.\n\n' + V1, 1);
    expect(byId(r, 'c2')).toMatchObject({ status: 'open', carried: 1, rev: 1 });
    expect(byId(r, 'c2').anchor.lines).toEqual([14, 14]);
    expect(byId(r, 'c2').anchor.prefix.endsWith('We launch ')).toBe(true);
    expect(r.summary).toMatchObject({ carried: 1, addressed: 0, round: 2 });
  });

  it('a deleted cut is addressed with an empty replacement', () => {
    const c = base([item('c3', 'cut', exact([12, 12], ' We launch soon.'), { note: '' })]);
    const r = triage(c, V1, V1.replace(' We launch soon.', ''), 1);
    expect(byId(r, 'c3')).toMatchObject({ status: 'addressed', replacedBy: '' });
  });

  it('leaves replacedBy undefined when the surrounding context is gone too', () => {
    const c = base([item('c4', 'fix', exact([12, 12], 'soon'))]);
    const r = triage(c, V1, V1.replace(/Latency target.*$/, 'Rewritten entirely.'), 1);
    expect(byId(r, 'c4').status).toBe('addressed');
    expect(byId(r, 'c4').replacedBy).toBeUndefined();
    expect(byId(r, 'c4').resolvedLines).toEqual([12, 12]);
  });
});

describe('triage — keep', () => {
  const keep = () => item('k5', 'keep', exact([12, 12], 'p95 under 200 ms'), { note: '' });
  it('re-anchors silently when untouched, without carrying', () => {
    const r = triage(base([keep()]), V1, 'x\n' + V1, 1);
    expect(byId(r, 'k5')).toMatchObject({ status: 'open', carried: 0 });
    expect(byId(r, 'k5').anchor.lines).toEqual([13, 13]);
    expect(r.summary.violated).toBe(0);
  });
  it('is violated by any change, including whitespace-only', () => {
    const changed = triage(base([keep()]), V1, V1.replace('200 ms', '250 ms'), 1);
    expect(byId(changed, 'k5')).toMatchObject({
      status: 'violated',
      replacedBy: 'p95 under 250 ms',
    });
    expect(changed.summary.violated).toBe(1);
    const reflowed = triage(base([keep()]), V1, V1.replace('p95 under', 'p95  under'), 1);
    expect(byId(reflowed, 'k5').status).toBe('violated');
  });
  it('is restored to open when the kept text comes back', () => {
    const v2 = V1.replace('200 ms', '250 ms');
    const first = triage(base([keep()]), V1, v2, 1);
    const second = triage(first.comments, v2, V1, 2);
    expect(byId(second, 'k5')).toMatchObject({ status: 'open', rev: 2 });
    expect(byId(second, 'k5').replacedBy).toBeUndefined();
    expect(second.summary).toMatchObject({ restored: 1, violated: 0, round: 3 });
  });
});

describe('triage — q, general, addressed, block, approx', () => {
  it('q stays open; when its quote is gone it falls back to a line-range block', () => {
    const c = base([item('c6', 'q', exact([12, 12], 'soon'))]);
    const r = triage(c, V1, V1.replace('soon', 'on 1 March'), 1);
    expect(byId(r, 'c6')).toMatchObject({ status: 'open', carried: 0 });
    expect(byId(r, 'c6').anchor.block).toEqual({ kind: 'lines', label: 'lines 12–12' });
  });
  it('general and already-addressed items only get the new rev; no round bump without open work', () => {
    const c = base([
      { id: 'c7', tag: 'general', note: 'Tone', rev: 0, status: 'addressed', carried: 0 },
      item('c8', 'fix', exact([12, 12], 'soon'), { status: 'addressed', resolvedRev: 0 }),
    ]);
    const r = triage(c, V1, V1 + '\nmore', 1);
    expect(byId(r, 'c7').rev).toBe(1);
    expect(byId(r, 'c8')).toMatchObject({ status: 'addressed', resolvedRev: 0, carried: 0 });
    expect(r.comments.round).toBe(1);
  });
  it('a block anchor follows its block, and is addressed when the block text changes', () => {
    const table = item('c9', 'fix', blockAnchor([8, 10], 'table', 'table under "Costs"'));
    const moved = triage(base([table]), V1, 'x\ny\n' + V1, 1);
    expect(byId(moved, 'c9')).toMatchObject({ status: 'open', carried: 1 });
    expect(byId(moved, 'c9').anchor.lines).toEqual([10, 12]);
    const edited = triage(base([table]), V1, V1.replace('| Workers | $5 |', '| Workers | $6 |'), 1);
    expect(byId(edited, 'c9')).toMatchObject({ status: 'addressed', resolvedLines: [8, 10] });
  });
  it('an approx anchor is found through inline markers, and gone when the words change', () => {
    const approx = item('c10', 'fix', captureAnchor(V1, [4, 4], 'a one-line flag'));
    expect(approx.anchor.approx).toBe(true);
    const kept = triage(base([approx]), V1, 'x\n' + V1, 1);
    expect(byId(kept, 'c10')).toMatchObject({ status: 'open', carried: 1 });
    expect(byId(kept, 'c10').anchor.lines).toEqual([5, 5]);
    const gone = triage(base([approx]), V1, V1.replace('**one-line** flag', 'single config'), 1);
    expect(byId(gone, 'c10').status).toBe('addressed');
  });
});

describe('helpers', () => {
  it('stripInline removes emphasis, code ticks and link syntax but never newlines', () => {
    expect(stripInline('a **b** _c_ `d` [e](http://x) ~~f~~\n![g](h.png)')).toBe('a b c d e f\ng');
  });
  it('replacedSpan needs prefix then suffix within reach', () => {
    const a = exact([12, 12], 'soon');
    expect(replacedSpan(V1.replace('soon', 'on 1 March'), a)).toEqual({
      text: 'on 1 March',
      lines: [12, 12],
    });
    expect(replacedSpan('nothing alike', a)).toBeNull();
  });
  it('reopenAnchor prefers the live anchor, then the replacement, then a line block', () => {
    const live = item('c1', 'fix', exact([12, 12], 'soon'), { status: 'addressed' });
    expect(reopenAnchor(V1, live)).toEqual(live.anchor);
    const v2 = V1.replace('soon', 'on 1 March');
    const replaced = { ...live, replacedBy: 'on 1 March', resolvedLines: [12, 12] };
    expect(reopenAnchor(v2, replaced)).toMatchObject({
      quote: 'on 1 March',
      approx: false,
      lines: [12, 12],
    });
    const lost = { ...live, replacedBy: undefined, resolvedLines: [40, 41] };
    expect(reopenAnchor('only\ntwo lines', lost)).toMatchObject({
      lines: [2, 2],
      block: { kind: 'lines', label: 'lines 2–2' },
    });
  });
});
