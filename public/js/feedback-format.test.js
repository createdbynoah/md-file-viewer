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

  // Helper for the overlap tests below: every {== and ==} in the output must
  // pair up and alternate strictly — CriticMarkup can't express crossing or
  // nested spans, so the formatter must never emit one.
  const assertBalanced = (out) => {
    const tokens = [...out.matchAll(/\{==|==\}/g)].map((m) => m[0]);
    expect(tokens.length % 2).toBe(0);
    for (let i = 0; i < tokens.length; i += 2) {
      expect(tokens[i]).toBe('{==');
      expect(tokens[i + 1]).toBe('==}');
    }
    return tokens;
  };

  it('keeps two comments on the same quote in one highlight, in id order', () => {
    const out = formatCriticMarkup(
      {
        round: 1,
        items: [item({ id: 'c1', tag: 'fix', note: 'A' }), item({ id: 'c2', tag: 'q', note: 'B' })],
      },
      SRC
    );
    expect(out).toBe(
      'Tail latency matters.\nMedian latency does not.\nShip {==soon==}{>>c1 fix: A<<}{>>c2 q: B<<}.'
    );
    assertBalanced(out);
  });

  it('degrades a nested quote to a trailing note, leaving exactly one open/close pair', () => {
    const outer = item({
      id: 'c1',
      tag: 'fix',
      note: 'Fix this',
      anchor: {
        quote: 'latency matters',
        approx: false,
        prefix: 'Tail ',
        suffix: '.',
        lines: [1, 1],
      },
    });
    const inner = item({
      id: 'c2',
      tag: 'q',
      note: 'Which?',
      anchor: {
        quote: 'matters',
        approx: false,
        prefix: 'Tail latency ',
        suffix: '.',
        lines: [1, 1],
      },
    });
    const out = formatCriticMarkup({ round: 1, items: [outer, inner] }, SRC);
    const tokens = assertBalanced(out);
    expect(tokens.length).toBe(2);
    expect(out).toContain(
      '{==latency matters==}{>>c1 fix: Fix this<<}{>>c2 q ~"matters": Which?<<}'
    );
  });

  it('degrades a partially overlapping quote the same way', () => {
    const first = item({
      id: 'c1',
      tag: 'fix',
      note: 'A',
      anchor: {
        quote: 'Tail latency',
        approx: false,
        prefix: '',
        suffix: ' matters.',
        lines: [1, 1],
      },
    });
    const second = item({
      id: 'c2',
      tag: 'q',
      note: 'B',
      anchor: {
        quote: 'latency matters',
        approx: false,
        prefix: 'Tail ',
        suffix: '.',
        lines: [1, 1],
      },
    });
    const out = formatCriticMarkup({ round: 1, items: [first, second] }, SRC);
    const tokens = assertBalanced(out);
    expect(tokens.length).toBe(2);
    expect(out).toContain('{==Tail latency==}{>>c1 fix: A<<}{>>c2 q ~"latency matters": B<<}');
  });

  it('keeps {== and ==} balanced and alternating for a handful of overlapping/nested ranges', () => {
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'.split(' ');
    const src = words.join(' ');
    const span = (from, to) => words.slice(from, to).join(' ');
    const mk = (id, quote) =>
      item({
        id,
        tag: 'fix',
        note: 'n',
        anchor: { quote, approx: false, prefix: '', suffix: '', lines: [1, 1] },
      });
    const items = [
      mk('c1', span(0, 3)), // alpha bravo charlie
      mk('c2', span(1, 4)), // bravo charlie delta      — overlaps c1
      mk('c3', span(2, 3)), // charlie                  — nested in c1
      mk('c4', span(3, 5)), // delta echo               — disjoint from c1
      mk('c5', span(6, 10)), // golf hotel india juliet — disjoint from all above
      mk('c6', span(7, 9)), // hotel india              — nested in c5
    ];
    const out = formatCriticMarkup({ round: 1, items }, src);
    const tokens = assertBalanced(out);
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('neutralizes a `<<}` inside a note so it cannot close the comment early', () => {
    const out = formatCriticMarkup(
      { round: 1, items: [item({ id: 'c1', note: 'close early <<} then more' })] },
      SRC
    );
    expect((out.match(/<<\}/g) || []).length).toBe(1);
    expect(out).toContain('{>>c1 fix: close early << } then more<<}');
  });

  it('degrades a quote that itself contains a delimiter instead of highlighting it', () => {
    const localSrc = 'Before ==} after.';
    const out = formatCriticMarkup(
      {
        round: 1,
        items: [
          item({
            id: 'c1',
            note: 'weird',
            anchor: {
              quote: '==}',
              approx: false,
              prefix: 'Before ',
              suffix: ' after.',
              lines: [1, 1],
            },
          }),
        ],
      },
      localSrc
    );
    expect(out).not.toContain('{==');
    expect(out).toBe('Before {>>c1 fix ~"== }": weird<<}==} after.');
  });

  it('lists violated keep items after general notes and before the document', () => {
    const out = formatCriticMarkup(
      {
        round: 1,
        items: [
          { id: 'g1', tag: 'general', note: 'Too salesy', status: 'open' },
          item({
            id: 'k2',
            tag: 'keep',
            status: 'violated',
            anchor: {
              quote: 'gone text',
              approx: false,
              prefix: '',
              suffix: '',
              lines: [1, 1],
            },
            resolvedLines: [2, 2],
          }),
          item({ id: 'c9', status: 'addressed' }),
        ],
      },
      SRC
    );
    expect(out).toBe(
      '{>>general: Too salesy<<}\n' +
        '{>>k2 keep VIOLATED — restore exactly: "gone text" (near L2)<<}\n' +
        SRC
    );
    expect(out).not.toContain('c9');
  });

  it('falls back to the anchor line when a violated item has no resolvedLines', () => {
    const out = formatCriticMarkup(
      {
        round: 1,
        items: [
          item({
            id: 'k2',
            tag: 'keep',
            status: 'violated',
            anchor: { quote: 'gone text', approx: false, prefix: '', suffix: '', lines: [5, 5] },
          }),
        ],
      },
      SRC
    );
    expect(out).toContain('(near L5)<<}');
  });

  it('flattens a newline in a block label and a literal replacement (G1)', () => {
    const out = formatCriticMarkup(
      {
        round: 1,
        items: [
          item({
            id: 'c1',
            tag: 'q',
            note: 'Why?',
            anchor: {
              quote: '',
              approx: false,
              prefix: '',
              suffix: '',
              lines: [2, 2],
              block: { kind: 'paragraph', label: 'paragraph "line one\nline two"' },
            },
          }),
          item({ id: 'c2', replace: 'a\nb' }),
        ],
      },
      SRC
    );
    const c1Comment = out.match(/\{>>c1[^]*?<<\}/)[0];
    expect(c1Comment).not.toContain('\n');
    expect(out).toContain('{==soon==}{>>c2 fix => "a b"<<}');
  });

  it('emits a line-start note before a highlight opening at the same offset (G2)', () => {
    const note = item({
      id: 'c2',
      tag: 'q',
      note: 'Which?',
      anchor: {
        quote: '',
        approx: false,
        prefix: '',
        suffix: '',
        lines: [3, 3],
        block: { kind: 'paragraph', label: 'para' },
      },
    });
    const exactItem = item({
      id: 'c1',
      tag: 'fix',
      note: 'Fix',
      anchor: { quote: 'Ship', approx: false, prefix: '', suffix: ' soon.', lines: [3, 3] },
    });
    const out = formatCriticMarkup({ round: 1, items: [exactItem, note] }, SRC);
    expect(out).toBe(
      'Tail latency matters.\nMedian latency does not.\n' +
        '{>>c2 q [para]: Which?<<}{==Ship==}{>>c1 fix: Fix<<} soon.'
    );
    const stripped = out
      .replace(/\{>>[^]*?<<\}/g, '')
      .replace(/\{==/g, '')
      .replace(/==\}/g, '');
    expect(stripped).toBe(SRC);
  });
});
