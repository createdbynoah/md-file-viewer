// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { buildComposer } from './comments-composer.js';

const quote = { quote: 'soon', approx: false, prefix: '', suffix: '', lines: [3, 3] };
const block = { ...quote, quote: '', block: { kind: 'table', label: 'table' } };
const q = (node, sel) => node.querySelector(sel);
const pressed = (node) => q(node, '.comment-tags [aria-pressed="true"]').textContent;

describe('buildComposer', () => {
  it('defaults to fix, shows Replace only for quoted fix comments', () => {
    const { node } = buildComposer({ anchor: quote, onSubmit: vi.fn(), onCancel: vi.fn() });
    expect(pressed(node)).toBe('1 fix');
    expect(q(node, 'input').hidden).toBe(false);
    q(node, '.comment-tags button:nth-child(2)').click();
    expect(pressed(node)).toBe('2 cut');
    expect(q(node, 'input').hidden).toBe(true);
    const blockComposer = buildComposer({ anchor: block, onSubmit: vi.fn(), onCancel: vi.fn() });
    expect(q(blockComposer.node, 'input').hidden).toBe(true);
  });

  it('requires a note for fix, not for cut', async () => {
    const onSubmit = vi.fn();
    const { node } = buildComposer({ anchor: quote, onSubmit, onCancel: vi.fn() });
    q(node, '.comment-save').click();
    await Promise.resolve();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(q(node, '.comment-error').textContent).toBe('Add a note first');
    q(node, '.comment-tags button:nth-child(2)').click();
    q(node, '.comment-save').click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith({
      body: { note: '', replace: '' },
      tag: 'cut',
      tagLocked: false,
    });
  });

  it('submits note + replace and shows a thrown error inline', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Could not save'));
    const { node } = buildComposer({ anchor: quote, onSubmit, onCancel: vi.fn() });
    q(node, 'textarea').value = 'Give a date';
    q(node, 'input').value = 'on 1 March';
    q(node, '.comment-save').click();
    await new Promise((r) => setTimeout(r));
    expect(onSubmit.mock.calls[0][0].body).toEqual({ note: 'Give a date', replace: 'on 1 March' });
    expect(q(node, '.comment-error').textContent).toBe('Could not save');
    expect(q(node, '.comment-save').disabled).toBe(false);
  });

  it('Alt+digit picks a tag by physical key; bare digits do not', () => {
    const { node } = buildComposer({ anchor: quote, onSubmit: vi.fn(), onCancel: vi.fn() });
    node.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', key: '3', bubbles: true }));
    expect(pressed(node)).toBe('1 fix');
    node.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Digit3', key: '£', altKey: true, bubbles: true })
    );
    expect(pressed(node)).toBe('3 q');
  });

  it('locks the tag for keep and general, and prefills when editing', () => {
    const keep = { id: 'k2', tag: 'keep', note: 'Approved', anchor: quote };
    const { node } = buildComposer({ existing: keep, onSubmit: vi.fn(), onCancel: vi.fn() });
    expect(q(node, '.comment-tags')).toBeNull();
    expect(q(node, 'textarea').value).toBe('Approved');
    const general = buildComposer({ isGeneral: true, onSubmit: vi.fn(), onCancel: vi.fn() });
    expect(q(general.node, '.comment-tags')).toBeNull();
    expect(q(general.node, 'input').hidden).toBe(true);
  });

  it('an existing non-keep comment cannot become keep', () => {
    const fix = { id: 'c1', tag: 'fix', note: 'x', anchor: quote };
    const { node } = buildComposer({ existing: fix, onSubmit: vi.fn(), onCancel: vi.fn() });
    q(node, '.comment-tags button:nth-child(4)').click();
    expect(pressed(node)).toBe('1 fix');
  });

  it('Escape and Cancel call onCancel; Cmd+Enter submits', async () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    const { node } = buildComposer({ anchor: quote, onSubmit, onCancel });
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    q(node, '.comment-cancel').click();
    expect(onCancel).toHaveBeenCalledTimes(2);
    q(node, 'textarea').value = 'n';
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })
    );
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
