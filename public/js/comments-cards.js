// public/js/comments-cards.js
// One review comment as a card. Used by the desktop rail, the tablet drawer,
// the mobile list sheet, and the tap-a-highlight item view.
import { el } from './el.js';

export function cardQuote(item) {
  return item.anchor.block ? `[${item.anchor.block.label}]` : `"${item.anchor.quote}"`;
}

/** Word diff of what replaced a quote, as <del>/<ins> text. */
export function buildMiniDiff(oldText, newText, diffWords) {
  const box = el('div', { className: 'comment-diff' });
  for (const part of diffWords(oldText, newText)) {
    box.append(el(part.added ? 'ins' : part.removed ? 'del' : 'span', { textContent: part.value }));
  }
  return box;
}

/**
 * @param {any} item
 * @param {{ orphaned: boolean, active: boolean, onActivate: () => void,
 *   onEdit: () => void, onToggle: () => void, onDelete: () => void,
 *   diffWords?: (a: string, b: string) => any[], onAccept?: () => void }} opts
 */
export function buildCard(
  item,
  { orphaned, active, onActivate, onEdit, onToggle, onDelete, diffWords, onAccept }
) {
  const violated = item.status === 'violated';
  const marker = violated ? ' · violated' : orphaned ? ' · anchor not found' : '';
  const card = el('div', { className: 'comment-card' }, [
    el('div', {
      className: 'comment-card-head',
      textContent: `${item.id} · ${item.tag}${marker} · ${cardQuote(item)}`,
    }),
  ]);
  card.dataset.id = item.id;
  card.dataset.tag = item.tag;
  card.classList.toggle('is-active', active);
  card.classList.toggle('is-addressed', item.status === 'addressed');
  card.classList.toggle('is-violated', violated);
  if (item.replace) {
    card.append(el('div', { className: 'comment-card-note', textContent: `→ ${item.replace}` }));
  }
  if (item.note) card.append(el('div', { className: 'comment-card-note', textContent: item.note }));

  if (diffWords && item.replacedBy !== undefined && item.anchor.quote) {
    card.append(buildMiniDiff(item.anchor.quote, item.replacedBy, diffWords));
  }

  const action = (label, fn, danger) => {
    const b = el('button', {
      type: 'button',
      className: `text-btn${danger ? ' danger' : ''}`,
      textContent: label,
    });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  const actions = violated
    ? [action('Accept change', onAccept)]
    : item.status === 'addressed'
      ? [action('Reopen', onToggle), action('Delete', onDelete, true)]
      : [action('Edit', onEdit), action('Resolve', onToggle), action('Delete', onDelete, true)];
  card.append(el('div', { className: 'comment-card-actions' }, actions));
  card.addEventListener('click', () => onActivate());
  return card;
}

export function buildGeneralCard(general, onOpen) {
  const card = el('div', { className: 'comment-card comments-general' }, [
    el('div', { className: 'comment-card-head', textContent: 'General note' }),
    el('div', {
      className: 'comment-card-note',
      textContent: general ? general.note : 'Add a note about the whole document',
    }),
  ]);
  card.addEventListener('click', () => onOpen());
  return card;
}
