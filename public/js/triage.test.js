import { describe, it, expect } from 'vitest';
import { captureAnchor, blockAnchor, anchorAt } from './anchor.js';
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

describe('triage — q found, still-violated keep, open general', () => {
  it('q found → re-anchored, stays open, never carries', () => {
    const c = base([item('q1', 'q', exact([12, 12], 'soon'))]);
    const r = triage(c, V1, 'x\n' + V1, 1);
    expect(byId(r, 'q1')).toMatchObject({ status: 'open', carried: 0, rev: 1 });
    expect(byId(r, 'q1').anchor.lines).toEqual([13, 13]);
    expect(byId(r, 'q1').anchor.block).toBeUndefined();
    expect(r.summary).toMatchObject({ carried: 0, addressed: 0, violated: 0, round: 2 });
  });

  it('a violated keep that is still gone stays violated and counts toward summary.violated', () => {
    const v2 = V1.replace('200 ms', '250 ms');
    const first = triage(
      base([item('k6', 'keep', exact([12, 12], 'p95 under 200 ms'), { note: '' })]),
      V1,
      v2,
      1
    );
    expect(byId(first, 'k6').status).toBe('violated');
    const still = V1.replace('200 ms', '300 ms'); // different edit, quote still not restored
    const second = triage(first.comments, v2, still, 2);
    expect(byId(second, 'k6')).toMatchObject({ status: 'violated', rev: 2 });
    expect(second.summary).toMatchObject({ violated: 1, restored: 0, round: 3 });
  });

  it('an open anchorless general item is untouched but its rev bumps and it counts as open work', () => {
    const c = base([
      { id: 'g1', tag: 'general', note: 'Tone', rev: 0, status: 'open', carried: 0 },
    ]);
    const r = triage(c, V1, V1 + '\nmore', 1);
    expect(byId(r, 'g1')).toMatchObject({ tag: 'general', note: 'Tone', status: 'open', rev: 1 });
    expect(r.comments.round).toBe(2); // round bumped: the anchorless open item still counts as work
  });
});

describe('triage — F2 approx anchors survive intra-word underscores', () => {
  const SRC = 'Intro.\n\nSet the **config_max_retries** value before deploy.';
  it('an approx fix on an underscored identifier survives an unrelated prepend, unchanged', () => {
    const anchor = captureAnchor(SRC, [3, 3], 'the config_max_retries value');
    expect(anchor.approx).toBe(true);
    const c = base([item('u1', 'fix', anchor)]);
    const r = triage(c, SRC, 'x\n' + SRC, 1);
    expect(byId(r, 'u1')).toMatchObject({ status: 'open', carried: 1, rev: 1 });
    expect(byId(r, 'u1').anchor.lines).toEqual([4, 4]);
  });
  it('is addressed when the identifier itself is renamed', () => {
    const anchor = captureAnchor(SRC, [3, 3], 'the config_max_retries value');
    const c = base([item('u2', 'fix', anchor)]);
    const r = triage(c, SRC, SRC.replace('config_max_retries', 'max_retry_count'), 1);
    expect(byId(r, 'u2').status).toBe('addressed');
  });
});

describe('triage — F3 blank block anchors', () => {
  // V1 line 11 is the blank line between the table and the latency paragraph.
  // There's no text to search for, so a blank block can't be *relocated* —
  // it's simply treated as still there at its old line number, clamped to
  // whatever range the new source actually has.
  it('a block anchor over a blank line is found (not gone) when the rest of the note is untouched', () => {
    const blank = item('bl1', 'fix', blockAnchor([11, 11], 'blank', 'blank line'));
    const r = triage(base([blank]), V1, V1 + '\ntrailing extra line', 1);
    expect(byId(r, 'bl1')).toMatchObject({ status: 'open', carried: 1 });
    expect(byId(r, 'bl1').anchor.lines).toEqual([11, 11]);
  });
  it('clamps a blank block anchor to the shrunken new source instead of losing it', () => {
    const blank = item('bl4', 'fix', blockAnchor([11, 11], 'blank', 'blank line'));
    const r = triage(base([blank]), V1, 'a\nb\nc', 1);
    expect(byId(r, 'bl4')).toMatchObject({ status: 'open', carried: 1 });
    expect(byId(r, 'bl4').anchor.lines).toEqual([3, 3]);
  });
});

describe('triage — F4 keep with duplicate text', () => {
  const DUPE = [
    'Intro line one.', // 1
    'Policy: retention is 30 days.', // 2 (anchored)
    'End of policy section.', // 3
    '', // 4
    'Notes: retention is 30 days.', // 5 (twin, never anchored)
    'End of notes.', // 6
  ].join('\n');
  const dupeAnchor = () => captureAnchor(DUPE, [2, 2], 'retention is 30 days.');

  it('the anchored occurrence being edited is violated even though a twin survives', () => {
    const c = base([item('kd1', 'keep', dupeAnchor(), { note: '' })]);
    // The quote text at line 2 is untouched, but its immediate context is
    // edited on both sides, so the live context at that spot no longer
    // matches the stored anchor — and the twin at line 5 never matched it
    // either, so neither surviving hit has a matching context.
    const edited = DUPE.replace('Policy: retention', 'Rule: retention').replace(
      'End of policy section.',
      'Close of rules.'
    );
    const r = triage(c, DUPE, edited, 1);
    expect(byId(r, 'kd1').status).toBe('violated');
    expect(r.summary.violated).toBe(1);
  });

  it('re-anchors to the right copy by context when lines shift and nothing is edited', () => {
    const c = base([item('kd2', 'keep', dupeAnchor(), { note: '' })]);
    const shifted = 'Prepended.\n\n' + DUPE;
    const r = triage(c, DUPE, shifted, 1);
    expect(byId(r, 'kd2')).toMatchObject({ status: 'open', carried: 0 });
    expect(byId(r, 'kd2').anchor.lines).toEqual([4, 4]);
  });
});

describe('triage — F6 block anchor line-label regeneration and clamping', () => {
  it('a lines-kind block anchor regenerates its label when it moves', () => {
    const linesAnchor = blockAnchor([12, 12], 'lines', 'lines 12–12');
    const r = triage(base([item('bl2', 'q', linesAnchor)]), V1, 'x\n' + V1, 1);
    expect(byId(r, 'bl2').anchor).toMatchObject({
      lines: [13, 13],
      block: { kind: 'lines', label: 'lines 13–13' },
    });
  });
  it('clamps a q fallback block to the shrunken new source', () => {
    const c = base([item('bl3', 'q', exact([12, 12], 'soon'))]);
    const shrunk = 'one\ntwo';
    const r = triage(c, V1, shrunk, 1);
    expect(byId(r, 'bl3').anchor).toMatchObject({
      lines: [2, 2],
      block: { kind: 'lines', label: 'lines 2–2' },
    });
  });
});

describe('triage — N1 approx anchor whose quote strips to nothing', () => {
  it('a marker-only approx quote (***) is treated as found at its old clamped lines, not searched', () => {
    // "***" strips to '' (stripInline removes all *): searching an empty
    // pattern would match at every offset (O(n), and produce an invalid
    // zero-width range). It must never auto-address either.
    const approxAnchor = { quote: '***', approx: true, prefix: '', suffix: '', lines: [4, 4] };
    const c = base([item('n1', 'fix', approxAnchor)]);
    const r = triage(c, V1, 'x\n' + V1, 1);
    expect(byId(r, 'n1')).toMatchObject({ status: 'open', carried: 1 });
    const [s, e] = byId(r, 'n1').anchor.lines;
    expect(s).toBeLessThanOrEqual(e);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(e).toBeLessThanOrEqual(13); // 'x\n' + V1 has 13 lines
    expect(byId(r, 'n1').anchor.lines).toEqual([4, 4]); // old position, clamped — same policy as a blank block
  });
});

describe('triage — N2 duplicate keep with legacy empty stored context', () => {
  const DUPE2 = [
    'Alpha section.', // 1
    'Retention window is 90 days.', // 2 (anchored, no stored context)
    'Beta section.', // 3
    'Retention window is 90 days.', // 4 (twin)
    'Gamma section.', // 5
  ].join('\n');
  const legacyAnchor = () => ({
    quote: 'Retention window is 90 days.',
    approx: false,
    prefix: '',
    suffix: '',
    lines: [2, 2],
  });

  it('an unchanged duplicate with no stored context stays open, not falsely violated', () => {
    const c = base([item('n2a', 'keep', legacyAnchor(), { note: '' })]);
    const r = triage(c, DUPE2, DUPE2, 1);
    expect(byId(r, 'n2a')).toMatchObject({ status: 'open', carried: 0 });
  });

  it('re-anchors to the nearest copy by line distance when lines shift, still open', () => {
    const c = base([item('n2b', 'keep', legacyAnchor(), { note: '' })]);
    const shifted = 'Intro.\n\n' + DUPE2;
    const r = triage(c, DUPE2, shifted, 1);
    expect(byId(r, 'n2b')).toMatchObject({ status: 'open', carried: 0 });
    expect(byId(r, 'n2b').anchor.lines).toEqual([4, 4]);
  });
});

describe('triage — N3 replacedSpan lines from the trimmed span', () => {
  const OLD = 'head para.\n\ntarget\n\ntail para.';
  it('reports lines spanning only the real (trimmed) replacement text, not boundary newlines', () => {
    const anchor = captureAnchor(OLD, [3, 3], 'target');
    const newSrc = OLD.replace('target', 'line one\nline two');
    expect(replacedSpan(newSrc, anchor)).toEqual({
      text: 'line one\nline two',
      lines: [3, 4],
    });
  });
  it('a fully deleted span still reports a single valid line, not a reversed/invalid range', () => {
    const anchor = captureAnchor(OLD, [3, 3], 'target');
    const deleted = OLD.replace('\n\ntarget\n\n', '\n\n');
    const span = replacedSpan(deleted, anchor);
    expect(span.text).toBe('');
    expect(span.lines[0]).toBe(span.lines[1]);
    expect(span.lines[0]).toBeGreaterThanOrEqual(1);
  });
});

describe('triage — R1 replacedSpan context fallback (32 -> 16 -> 8 chars)', () => {
  it('(a) seed situation: quote replaced on its own line AND a neighboring edit sits inside the 32-char suffix — still pins the replacement', () => {
    const OLD = [
      '# Launch brief',
      '',
      'We will ship to all customers in a single release.',
      'Latency target: p95 under 200 ms.',
      'Rollback is a one-line flag flip.',
      '',
      'The beta ends soon.',
      '',
    ].join('\n');
    const NEW = OLD.replace(
      'all customers in a single release',
      'customers in three stages'
    ).replace('200 ms', '250 ms');
    const anchor = captureAnchor(OLD, [3, 3], 'all customers in a single release');
    expect(replacedSpan(NEW, anchor)).toEqual({
      text: 'customers in three stages',
      lines: [3, 3],
    });
  });

  it('(b) edit inside the 32-char PREFIX on the previous line — falls back to the last 8 chars and still pins', () => {
    const HEAD = 'A'.repeat(24);
    const TAIL_CTX = 'zzzzzzzz'; // 8 chars directly touching the quote; the only part that survives
    const OLD = `${HEAD}${TAIL_CTX}TARGET unchanged-suffix`;
    const NEW = `${'B'.repeat(24)}${TAIL_CTX}REPLACEMENT unchanged-suffix`;
    const anchor = captureAnchor(OLD, [1, 1], 'TARGET');
    // Sanity: the full 32-char prefix (HEAD + TAIL_CTX) must be what got captured.
    expect(anchor.prefix).toBe(HEAD + TAIL_CTX);
    // Full (32) and 16-char tiers still reach into the changed HEAD and fail;
    // only the last-8 tier (pure TAIL_CTX) survives.
    expect(replacedSpan(NEW, anchor)).toEqual({
      text: 'REPLACEMENT',
      lines: [1, 1],
    });
  });

  it('(c) both neighbours rewritten entirely, no 8-char context survives — null', () => {
    const OLD = `${'A'.repeat(24)}zzzzzzzzTARGET unchanged-suffix`;
    const NEW = `${'B'.repeat(24)}yyyyyyyyREPLACEMENT totally-different-tail`;
    const anchor = captureAnchor(OLD, [1, 1], 'TARGET');
    expect(replacedSpan(NEW, anchor)).toBeNull();
  });

  it('(d) documented behavior: in a repetitive document, a decoy 8-char suffix match closer to the edit wins over the real (farther) one, as long as it is within the 2000-char cap', () => {
    const PREFIX = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabc'; // unique chars, no internal repeats
    const TAG8 = 'TAGXTAGX';
    const OLD = `${PREFIX}TARGET${TAG8}${'X'.repeat(24)}-END`;
    const NEW = `${PREFIX}REPLACEMENT ${TAG8} decoy junk here not real ${TAG8}${'Y'.repeat(24)}-END`;
    const anchor = captureAnchor(OLD, [1, 1], 'TARGET');
    // Full (32) and 16-char suffix tiers reach past TAG8 into content that
    // changed (X's -> Y's) and fail; the 8-char tier (TAG8 alone) succeeds,
    // but TAG8 also occurs as a decoy right after the edit, closer than the
    // real (unedited) occurrence further down — `indexOf` finds the decoy
    // first, so the reported replacement stops there. This is the existing,
    // intentional "nearest following occurrence" behavior, just reachable at
    // a shorter tier now — not a new bug.
    expect(replacedSpan(NEW, anchor)).toEqual({
      text: 'REPLACEMENT',
      lines: [1, 1],
    });
  });
});

describe('triage — I3 re-pinning resolved lines across later revisions', () => {
  const keep = () => item('k1', 'keep', exact([12, 12], 'p95 under 200 ms'), { note: '' });
  const v2 = V1.replace('200 ms', '250 ms');
  const violated = () => triage(base([keep()]), V1, v2, 1);

  it('a still-violated keep follows its replacement text to the new lines', () => {
    const first = violated();
    expect(byId(first, 'k1')).toMatchObject({
      resolvedLines: [12, 12],
      replacedBy: 'p95 under 250 ms',
      linesRev: 1,
    });
    const shifted = 'a\nb\nc\nd\ne\nf\n' + v2;
    const second = triage(first.comments, v2, shifted, 2);
    expect(byId(second, 'k1')).toMatchObject({
      status: 'violated',
      resolvedLines: [18, 18],
      replacedBy: 'p95 under 250 ms',
      linesRev: 2,
    });
  });

  it('re-runs replacedSpan when the replacement itself was edited again', () => {
    const first = violated();
    const third = V1.replace('200 ms', '300 ms');
    const second = triage(first.comments, v2, third, 2);
    expect(byId(second, 'k1')).toMatchObject({
      status: 'violated',
      replacedBy: 'p95 under 300 ms',
      resolvedLines: [12, 12],
      linesRev: 2,
    });
  });

  it('shifts nothing when neither the replacement nor its context can be pinned', () => {
    const first = violated();
    const unrelated = 'Nothing alike at all.\nSecond line.';
    const second = triage(first.comments, v2, unrelated, 2);
    expect(byId(second, 'k1')).toMatchObject({
      status: 'violated',
      resolvedLines: [12, 12],
      linesRev: 1, // stale on purpose: no honest new position to report
    });
  });

  it('re-pins an addressed item without changing its status', () => {
    const c = base([item('c1', 'fix', exact([12, 12], 'soon'))]);
    const v2b = V1.replace('We launch soon.', 'We launch on 1 March.');
    const first = triage(c, V1, v2b, 1);
    expect(byId(first, 'c1')).toMatchObject({ status: 'addressed', replacedBy: 'on 1 March' });
    const second = triage(first.comments, v2b, 'x\ny\n' + v2b, 2);
    expect(byId(second, 'c1')).toMatchObject({
      status: 'addressed',
      resolvedRev: 1,
      resolvedLines: [14, 14],
      linesRev: 2,
      rev: 2,
    });
  });
});

describe('triage — I1/I2 duplicated text needs surviving context', () => {
  const DUP = [
    '# Cadence', // 1
    '', // 2
    'We ship weekly.', // 3 (twin, never anchored)
    'Middle line.', // 4
    '', // 5
    'More text here.', // 6
    'We ship weekly.', // 7 (anchored)
    'Tail line.', // 8
  ].join('\n');
  const atSeven = () => captureAnchor(DUP, [7, 7], 'We ship weekly.');
  // Only the L7 copy is rewritten; the L3 twin survives byte-identical.
  const rewritten = DUP.replace(
    'More text here.\nWe ship weekly.',
    'More text here.\nWe ship twice a week.'
  );

  it('a fix on the L7 copy is addressed, not falsely carried onto the untouched L3 twin', () => {
    const r = triage(base([item('d1', 'fix', atSeven())]), DUP, rewritten, 1);
    expect(byId(r, 'd1')).toMatchObject({ status: 'addressed', carried: 0, rev: 1 });
    expect(r.summary).toMatchObject({ addressed: 1, carried: 0 });
  });

  it('a keep on the L7 copy is violated even though one exact hit survives', () => {
    const r = triage(base([item('kd7', 'keep', atSeven(), { note: '' })]), DUP, rewritten, 1);
    expect(byId(r, 'kd7').status).toBe('violated');
    expect(r.summary.violated).toBe(1);
  });

  it('a short duplicated quote ("the") is addressed rather than jumping to a twin', () => {
    const SRC = 'the alpha line.\n\nthe omega line.';
    const anchor = captureAnchor(SRC, [3, 3], 'the');
    const r = triage(
      base([item('d2', 'fix', anchor)]),
      SRC,
      SRC.replace('the omega', 'an omega'),
      1
    );
    expect(byId(r, 'd2').status).toBe('addressed');
  });

  it('a duplicate whose own context survives is still carried, at its new lines', () => {
    const r = triage(base([item('d3', 'fix', atSeven())]), DUP, 'Prepended.\n\n' + DUP, 1);
    expect(byId(r, 'd3')).toMatchObject({ status: 'open', carried: 1 });
    expect(byId(r, 'd3').anchor.lines).toEqual([9, 9]);
  });

  it('a unique quote is still found without any context agreement', () => {
    const anchor = captureAnchor(DUP, [4, 4], 'Middle line.');
    const moved = DUP.replace('# Cadence', '# Release cadence').replace(
      '\n\nMore text',
      '\nMore text'
    );
    const r = triage(base([item('d4', 'fix', anchor)]), DUP, moved, 1);
    expect(byId(r, 'd4')).toMatchObject({ status: 'open', carried: 1 });
  });

  it('a legacy duplicate with no stored context falls back to the nearest hit', () => {
    const legacy = {
      quote: 'We ship weekly.',
      approx: false,
      prefix: '',
      suffix: '',
      lines: [7, 7],
    };
    const r = triage(base([item('d5', 'fix', legacy)]), DUP, 'Intro.\n' + DUP, 1);
    expect(byId(r, 'd5')).toMatchObject({ status: 'open', carried: 1 });
    expect(byId(r, 'd5').anchor.lines).toEqual([8, 8]); // the anchored copy, nearest L7
  });
});

describe('triage — F1 performance at Worker scale', () => {
  it('triages 400 items against a ~1 MB repetitive note in well under 5s', () => {
    const N = 15000;
    const TAIL = 'consectetur adipiscing elit sed do eiusmod tempor';
    const lines = [];
    for (let i = 0; i < N; i++) lines.push(`${TAIL} MARK_${i}_END`);
    const src = lines.join('\n');

    const items = [];
    const editedRows = [];
    const step = Math.floor((N * 0.6) / 300);
    for (let k = 0; k < 300; k++) {
      const row = 1 + k * step;
      editedRows.push(row);
      const needle = `MARK_${row}_END`;
      const start = src.indexOf(needle);
      items.push(item(`e${k}`, 'fix', anchorAt(src, start, start + needle.length)));
    }
    const baseFound = Math.floor(N * 0.8);
    for (let k = 0; k < 100; k++) {
      const row = baseFound + k * 3;
      const needle = `MARK_${row}_END`;
      const start = src.indexOf(needle);
      items.push(item(`f${k}`, 'fix', anchorAt(src, start, start + needle.length)));
    }

    const comments = base(items);
    let newSrc = src;
    for (const row of editedRows) newSrc = newSrc.replace(`MARK_${row}_END`, `CHANGED_${row}_DONE`);

    const t0 = performance.now();
    const r = triage(comments, src, newSrc, 2);
    const elapsed = performance.now() - t0;

    expect(r.summary.addressed).toBe(300);
    expect(r.summary.carried).toBe(100);
    // Observed ~700-1100ms locally; 5s leaves real margin for a CI runner
    // 2-3x slower than dev hardware while still failing loudly on a
    // regression — the pre-fix (lineAt-scan) code takes minutes on this
    // exact fixture (>120s measured via a standalone repro), so 5s vs.
    // "minutes" is not a meaningfully weaker regression guard.
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('helpers', () => {
  it('stripInline removes emphasis, code ticks and link syntax but never newlines', () => {
    expect(stripInline('a **b** _c_ `d` [e](http://x) ~~f~~\n![g](h.png)')).toBe('a b c d e f\ng');
  });
  it('stripInline keeps intra-word underscores (identifiers) but strips real emphasis', () => {
    expect(stripInline('snake_case_name')).toBe('snake_case_name');
    expect(stripInline('_emph_')).toBe('emph');
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
