// public/js/comments-cards.js
// One review comment as a card. Used by the desktop rail, the tablet drawer,
// the mobile list sheet, and the tap-a-highlight item view.
import { el } from './el.js';

export function cardQuote(item) {
  return item.anchor.block ? `[${item.anchor.block.label}]` : `"${item.anchor.quote}"`;
}

/**
 * @param {any} item
 * @param {{ orphaned: boolean, active: boolean, onActivate: () => void,
 *   onEdit: () => void, onToggle: () => void, onDelete: () => void }} opts
 */
export function buildCard(item, { orphaned, active, onActivate, onEdit, onToggle, onDelete }) {
  const card = el('div', { className: 'comment-card' }, [
    el('div', {
      className: 'comment-card-head',
      textContent: `${item.id} · ${item.tag}${orphaned ? ' · anchor not found' : ''} · ${cardQuote(item)}`,
    }),
  ]);
  card.dataset.id = item.id;
  card.dataset.tag = item.tag;
  card.classList.toggle('is-active', active);
  card.classList.toggle('is-addressed', item.status === 'addressed');
  if (item.replace) {
    card.append(el('div', { className: 'comment-card-note', textContent: `→ ${item.replace}` }));
  }
  if (item.note) card.append(el('div', { className: 'comment-card-note', textContent: item.note }));

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
  card.append(
    el('div', { className: 'comment-card-actions' }, [
      action('Edit', onEdit),
      action(item.status === 'open' ? 'Resolve' : 'Reopen', onToggle),
      action('Delete', onDelete, true),
    ])
  );
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
