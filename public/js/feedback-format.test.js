import { describe, it, expect } from 'vitest';
import { formatFeedback, formatCriticMarkup } from './feedback-format.js';

const SRC = 'Tail latency matters.\nMedian latency does not.\nShip soon.';
const item = (over) => ({
  id: 'c1',
  tag: 'fix',
  note: '',
  status: 'open',
  carried: 0,
  anchor: { quote: 'soon', approx: false, prefix: 'Ship ', suffix: '.', lines: [3, 3] },
  ...over,
});
const fmt = (items, opts, round = 1) =>
  formatFeedback({ round, items }, SRC, { title: 'Plan', rev: 3 }, opts);

describe('formatFeedback', () => {
  it('emits the legend header with title, rev and round', () => {
    const out = fmt([item({ note: 'Give a date' })], undefined, 2);
    expect(out.split('\n')[0]).toBe('# feedback · "Plan" · rev 3 · round 2');
    expect(out).toContain('L = line @ rev 3.');
    expect(out).toContain('keep=leave byte-identical');
  });
  it('formats an open fix with an indented note', () => {
    expect(fmt([item({ note: 'Give a date' })])).toContain('OPEN\nc1 fix L3 "soon"\n  Give a date');
  });
  it('omits the note line for cut and keep, and orders KEEP before OPEN', () => {
    const out = fmt([item({ id: 'c2', tag: 'cut' }), item({ id: 'k3', tag: 'keep' })]);
    expect(out).toContain('KEEP\nk3 L3 "soon"\n\nOPEN\nc2 cut L3 "soon"');
  });
  it('adds context only when the quote is ambiguous', () => {
    const dup = item({
      anchor: {
        quote: 'latency',
        approx: false,
        prefix: 'Tail ',
        suffix: ' matters.',
        lines: [1, 1],
      },
    });
    expect(fmt([dup])).toContain('c1 fix L1 "latency" <in "…Tail [latency] matters.…">');
    expect(fmt([item()])).not.toContain('<in');
  });
  it('elides quotes longer than 12 words and uses a line range', () => {
    const long = 'one two three four\nfive six seven eight\nnine ten eleven twelve thirteen';
    const out = formatFeedback(
      {
        round: 1,
        items: [
          item({ anchor: { quote: long, approx: false, prefix: '', suffix: '', lines: [2, 4] } }),
        ],
      },
      `head\n${long}`,
      { title: 'T', rev: 0 }
    );
    expect(out).toContain('L2-4 "one two three four five … nine ten eleven twelve thirteen"');
  });
  it('marks approx quotes, block anchors, literal replacements and carried items', () => {
    const out = fmt(
      [
        item({ id: 'c1', anchor: { ...item().anchor, approx: true } }),
        item({
          id: 'c2',
          anchor: {
            quote: '',
            approx: false,
            prefix: '',
            suffix: '',
            lines: [1, 2],
            block: { kind: 'table', label: 'table under "Costs"' },
          },
          note: 'Add totals',
        }),
        item({ id: 'c3', replace: 'on 1 March' }),
        item({ id: 'c4', carried: 1, note: 'Still vague' }),
      ],
      undefined,
      2
    );
    expect(out).toContain('c1 fix L3 ~"soon"');
    expect(out).toContain('c2 fix L1-2 [table under "Costs"]\n  Add totals');
    expect(out).toContain('c3 fix L3 "soon" => "on 1 March"');
    expect(out).toContain('c4 fix L3 "soon" (carried: unchanged since round 1)');
  });
  it('puts general notes last, without id or anchor', () => {
    const out = fmt([item(), { id: 'c9', tag: 'general', note: 'Too salesy', status: 'open' }]);
    expect(out.endsWith('GENERAL\n  Too salesy')).toBe(true);
  });
  it('sorts OPEN in document order, skips addressed by default, escapes quotes/newlines', () => {
    const a = item({
      id: 'c2',
      anchor: { quote: 'Tail "x"\ny', approx: false, prefix: '', suffix: '', lines: [1, 2] },
    });
    const out = fmt([item({ id: 'c1' }), a, item({ id: 'c3', status: 'addressed' })]);
    expect(out.indexOf('c2 ')).toBeLessThan(out.indexOf('c1 '));
    expect(out).toContain('"Tail \\"x\\"\\ny"');
    expect(out).not.toContain('c3 ');
    expect(fmt([item({ id: 'c3', status: 'addressed' })], { includeAddressed: true })).toContain(
      'ADDRESSED\nc3 fix L3 "soon"'
    );
  });
  it('prints the line the quote is on NOW, not the line it was captured at', () => {
    const moved = `intro\n\n${SRC}`;
    const out = formatFeedback({ round: 1, items: [item({ note: 'Give a date' })] }, moved, {
      title: 'Plan',
      rev: 4,
    });
    expect(out).toContain('c1 fix L5 "soon"');
    expect(out).not.toContain('L3');
  });
  it('keeps the stored lines and flags anchors that are gone', () => {
    const out = fmt([item({ id: 'c1', anchor: { ...item().anchor, quote: 'vanished' } })]);
    expect(out).toContain('c1 fix L3 "vanished" (anchor not found in current source)');
  });
  it('sorts by the resolved lines, not the stored ones', () => {
    const early = item({
      id: 'c9',
      anchor: { quote: 'Tail', approx: false, prefix: '', suffix: ' latency', lines: [9, 9] },
    });
    const out = fmt([item({ id: 'c1' }), early]);
    expect(out.indexOf('c9 ')).toBeLessThan(out.indexOf('c1 '));
  });
  it('omits empty sections and says so when nothing is open', () => {
    expect(fmt([])).toMatch(/\n\n\(no open feedback\)$/);
  });
  it('covers VIOLATED section with violated keep item', () => {
    const out = fmt([
      item({ id: 'k1', tag: 'keep', status: 'open' }),
      item({ id: 'k2', tag: 'keep', status: 'violated' }),
      item({ id: 'c1', tag: 'fix', status: 'open' }),
    ]);
    expect(out).toContain('VIOLATED — kept text was changed; restore it');
    expect(out).toContain('k2 L3 "soon"');
    expect(out.indexOf('VIOLATED')).toBeLessThan(out.indexOf('KEEP'));
    expect(out.indexOf('KEEP')).toBeLessThan(out.indexOf('OPEN'));
  });
  it('allows optional note on keep items', () => {
    const out = fmt([item({ id: 'k3', tag: 'keep', note: 'Approved wording' })]);
    expect(out).toContain('k3 L3 "soon"\n  Approved wording');
  });
  it('does not elide quotes of exactly 12 words', () => {
    const twelve = 'one two three four five six seven eight nine ten eleven twelve';
    const out = formatFeedback(
      {
        round: 1,
        items: [
          item({ anchor: { quote: twelve, approx: false, prefix: '', suffix: '', lines: [1, 1] } }),
        ],
      },
      twelve,
      { title: 'T', rev: 0 }
    );
    expect(out).toContain(`"${twelve}"`);
    expect(out).not.toContain('…');
  });
});

describe('triaged items', () => {
  const gone = { quote: 'gone text', approx: false, prefix: '', suffix: '', lines: [1, 1] };
  it('prints resolved lines for violated and addressed items, without the not-found marker', () => {
    const out = fmt(
      [
        item({ id: 'k2', tag: 'keep', status: 'violated', anchor: gone, resolvedLines: [2, 2] }),
        item({
          id: 'c3',
          status: 'addressed',
          anchor: gone,
          resolvedLines: [3, 3],
          resolvedRev: 4,
        }),
      ],
      { includeAddressed: true }
    );
    expect(out).toContain('VIOLATED — kept text was changed; restore it\nk2 L2 "gone text"');
    expect(out).toContain('ADDRESSED\nc3 fix L3 "gone text" (addressed in rev 4)');
    expect(out).not.toContain('anchor not found');
  });
});

describe('formatCriticMarkup', () => {
  it('wraps located quotes and notes blocks and general inline, leaving the rest byte-identical', () => {
    const out = formatCriticMarkup(
      {
        round: 1,
        items: [
          item({ id: 'c1', note: 'Give a date' }),
          item({
            id: 'c2',
            tag: 'q',
            note: 'Why?',
            anchor: {
              quote: '',
              approx: false,
              prefix: '',
              suffix: '',
              lines: [2, 2],
              block: { kind: 'paragraph', label: 'paragraph "Median latency"' },
            },
          }),
          { id: 'c3', tag: 'general', note: 'Too salesy', status: 'open' },
          item({ id: 'c4', status: 'addressed' }),
        ],
      },
      SRC
    );
    expect(out).toBe(
      '{>>general: Too salesy<<}\n' +
        'Tail latency matters.\n' +
        '{>>c2 q [paragraph "Median latency"]: Why?<<}Median latency does not.\n' +
        'Ship {==soon==}{>>c1 fix: Give a date<<}.'
    );
  });
  it('carries a literal replacement and keeps notes on one line', () => {
    const out = formatCriticMarkup(
      { round: 1, items: [item({ id: 'c1', note: 'a\nb', replace: 'on 1 March' })] },
      SRC
    );
    expect(out).toContain('{==soon==}{>>c1 fix => "on 1 March": a b<<}');
  });
});
