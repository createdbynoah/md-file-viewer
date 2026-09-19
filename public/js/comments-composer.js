// public/js/comments-composer.js
// The comment form: tag chips, note, optional literal replacement, Save/Cancel.
// Presentation-agnostic — comments-ui.js decides whether it sits in a popover
// or a bottom sheet.
import { el } from './el.js';

export const TAGS = ['fix', 'cut', 'q', 'keep'];
export const NOTE_OPTIONAL = new Set(['cut', 'keep']);

/**
 * @param {{ existing?: any, isGeneral?: boolean, anchor?: any,
 *   onSubmit: (payload: { body: { note: string, replace: string }, tag: string, tagLocked: boolean }) => any,
 *   onCancel: () => void }} opts
 * @returns {{ node: HTMLElement, focus: () => void }}
 */
export function buildComposer({
  existing = null,
  isGeneral = false,
  anchor = null,
  onSubmit,
  onCancel,
}) {
  let tag = existing ? existing.tag : isGeneral ? 'general' : 'fix';
  // keep/general ids are fixed (see the PATCH rules), so their tag cannot change.
  const tagLocked = isGeneral || Boolean(existing && existing.tag === 'keep');
  const target = anchor || (existing && existing.anchor) || null;
  const hasQuote = Boolean(target && !target.block);

  const tagRow = el('div', { className: 'comment-tags' });
  const tagButtons = TAGS.map((t, i) => {
    const b = el('button', { type: 'button', textContent: `${i + 1} ${t}` });
    b.addEventListener('click', () => setTag(t));
    tagRow.append(b);
    return b;
  });
  const noteInput = el('textarea', { rows: 2, placeholder: 'Add a note' });
  const replaceInput = el('input', { type: 'text', placeholder: 'Replace with (optional, exact)' });
  const error = el('span', { className: 'comment-error' });
  const saveBtn = el('button', {
    type: 'button',
    className: 'primary-btn comment-save',
    textContent: 'Save',
  });
  const cancelBtn = el('button', {
    type: 'button',
    className: 'text-btn comment-cancel',
    textContent: 'Cancel',
  });
  if (existing) {
    noteInput.value = existing.note || '';
    replaceInput.value = existing.replace || '';
  }

  function setTag(next) {
    if (tagLocked || (existing && next === 'keep')) return;
    tag = next;
    tagButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(TAGS[i] === tag)));
    replaceInput.hidden = !(hasQuote && tag === 'fix');
  }

  async function save() {
    const body = { note: noteInput.value, replace: replaceInput.hidden ? '' : replaceInput.value };
    if (!NOTE_OPTIONAL.has(tag) && !body.note.trim() && !body.replace.trim()) {
      error.textContent = 'Add a note first';
      return;
    }
    error.textContent = '';
    saveBtn.disabled = true;
    try {
      await onSubmit({ body, tag, tagLocked });
    } catch (e) {
      error.textContent = e.message;
    } finally {
      saveBtn.disabled = false;
    }
  }

  const node = el('div', { className: 'comment-composer' }, [
    ...(tagLocked ? [] : [tagRow]),
    noteInput,
    replaceInput,
    el('div', { className: 'comment-composer-foot' }, [
      el('span', { className: 'comment-hint', textContent: '⌥1–4 tag · ⌘↵ save · esc cancel' }),
      error,
      cancelBtn,
      saveBtn,
    ]),
  ]);
  setTag(tag);
  if (tagLocked) replaceInput.hidden = true;

  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', () => onCancel());
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') onCancel();
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
    // Alt/Option+1–4 only — bare digits must always type into the note. macOS
    // Option+digit remaps e.key, so match the physical key via e.code.
    else if (!tagLocked && e.altKey && /^Digit[1-4]$/.test(e.code)) {
      e.preventDefault();
      setTag(TAGS[Number(e.code.slice(-1)) - 1]);
    }
  });

  return { node, focus: () => noteInput.focus() };
}
