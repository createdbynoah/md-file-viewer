// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { buildCard, buildGeneralCard, buildMiniDiff, cardQuote } from './comments-cards.js';

const item = (over = {}) => ({
  id: 'c1',
  tag: 'fix',
  note: '<img src=x onerror=alert(1)>',
  status: 'open',
  anchor: { quote: 'soon', approx: false, prefix: '', suffix: '', lines: [3, 3] },
  ...over,
});
const handlers = () => ({
  onActivate: vi.fn(),
  onEdit: vi.fn(),
  onToggle: vi.fn(),
  onDelete: vi.fn(),
});

describe('buildCard', () => {
  it('renders user text as text, never as markup', () => {
    const card = buildCard(item(), { orphaned: false, active: false, ...handlers() });
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.comment-card-note').textContent).toBe(
      '<img src=x onerror=alert(1)>'
    );
    expect(card.dataset.id).toBe('c1');
    expect(card.dataset.tag).toBe('fix');
  });
  it('head shows id, tag, quote, and the orphan marker', () => {
    const card = buildCard(item(), { orphaned: true, active: false, ...handlers() });
    expect(card.querySelector('.comment-card-head').textContent).toBe(
      'c1 · fix · anchor not found · "soon"'
    );
    const block = item({ anchor: { ...item().anchor, block: { kind: 'table', label: 'table' } } });
    expect(cardQuote(block)).toBe('[table]');
  });
  it('shows the replacement, and state classes', () => {
    const card = buildCard(item({ replace: 'on 1 March', status: 'addressed' }), {
      orphaned: false,
      active: true,
      ...handlers(),
    });
    expect(card.querySelectorAll('.comment-card-note')[0].textContent).toBe('→ on 1 March');
    expect(card.classList.contains('is-active')).toBe(true);
    expect(card.classList.contains('is-addressed')).toBe(true);
  });
  it('action buttons call their handler without activating the card', () => {
    const h = handlers();
    const card = buildCard(item(), { orphaned: false, active: true, ...h });
    const [edit, toggle, del] = card.querySelectorAll('.comment-card-actions button');
    expect(toggle.textContent).toBe('Resolve');
    edit.click();
    toggle.click();
    del.click();
    expect(h.onEdit).toHaveBeenCalledTimes(1);
    expect(h.onToggle).toHaveBeenCalledTimes(1);
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onActivate).not.toHaveBeenCalled();
    card.click();
    expect(h.onActivate).toHaveBeenCalledTimes(1);
  });
  it('an addressed card offers Reopen', () => {
    const card = buildCard(item({ status: 'addressed' }), {
      orphaned: false,
      active: true,
      ...handlers(),
    });
    expect(card.querySelectorAll('.comment-card-actions button')[0].textContent).toBe('Reopen');
  });
});

const fakeDiff = (a, b) => [
  { value: 'ship ' },
  { value: a.replace('ship ', ''), removed: true },
  { value: b.replace('ship ', ''), added: true },
];

describe('triaged cards', () => {
  it('buildMiniDiff renders parts as del/ins text, never markup', () => {
    const d = buildMiniDiff('ship soon', 'ship <b>1 March</b>', fakeDiff);
    expect(d.className).toBe('comment-diff');
    expect(d.querySelector('del').textContent).toBe('soon');
    expect(d.querySelector('ins').textContent).toBe('<b>1 March</b>');
    expect(d.querySelector('b')).toBeNull();
  });
  it('an addressed card shows the mini-diff and offers Reopen and Delete only', () => {
    const card = buildCard(item({ status: 'addressed', replacedBy: 'on 1 March' }), {
      orphaned: false,
      active: false,
      diffWords: fakeDiff,
      ...handlers(),
    });
    expect(card.querySelector('.comment-diff')).not.toBeNull();
    expect(
      [...card.querySelectorAll('.comment-card-actions button')].map((b) => b.textContent)
    ).toEqual(['Reopen', 'Delete']);
  });
  it('a violated keep is marked, never "anchor not found", and offers Accept change', () => {
    const onAccept = vi.fn();
    const card = buildCard(item({ id: 'k2', tag: 'keep', status: 'violated', replacedBy: 'x' }), {
      orphaned: true,
      active: false,
      diffWords: fakeDiff,
      onAccept,
      ...handlers(),
    });
    expect(card.classList.contains('is-violated')).toBe(true);
    expect(card.querySelector('.comment-card-head').textContent).toBe(
      'k2 · keep · violated · "soon"'
    );
    const buttons = card.querySelectorAll('.comment-card-actions button');
    expect([...buttons].map((b) => b.textContent)).toEqual(['Accept change']);
    buttons[0].click();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
  it('no mini-diff when the replacement is unknown or there is no quote', () => {
    const card = buildCard(item({ status: 'addressed' }), {
      orphaned: false,
      active: false,
      diffWords: fakeDiff,
      ...handlers(),
    });
    expect(card.querySelector('.comment-diff')).toBeNull();
  });
});

describe('buildGeneralCard', () => {
  it('shows the note or an invitation, and opens on click', () => {
    const onOpen = vi.fn();
    const empty = buildGeneralCard(undefined, onOpen);
    expect(empty.querySelector('.comment-card-note').textContent).toBe(
      'Add a note about the whole document'
    );
    empty.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    const filled = buildGeneralCard({ id: 'c4', tag: 'general', note: 'Too salesy' }, onOpen);
    expect(filled.querySelector('.comment-card-note').textContent).toBe('Too salesy');
  });
});
