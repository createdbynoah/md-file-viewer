// public/js/comments-ui.js
// Review mode for the rendered note: select text (or a block) to comment,
// highlights via the CSS Custom Highlight API, a margin rail of cards, and
// "Copy feedback". All anchoring maths lives in anchor.js; this file is DOM glue.
import { captureAnchor, blockAnchor, locate, nthInLines, wsRegex } from './anchor.js';
import { formatFeedback } from './feedback-format.js';

const TAGS = ['fix', 'cut', 'q', 'keep'];
const NOTE_OPTIONAL = new Set(['cut', 'keep']);
const HIGHLIGHT_FOR = {
  fix: 'review-fix',
  q: 'review-fix',
  keep: 'review-keep',
  cut: 'review-cut',
};
const CARD_GAP = 8;
const canHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}

function parseLines(node) {
  const [s, e] = node.dataset.line.split(',').map(Number);
  return [s, e];
}

/** Smallest [data-line] element covering the line range, or null. */
function blockFor(root, [s, e]) {
  let best = null;
  for (const node of root.querySelectorAll('[data-line]')) {
    const [bs, be] = parseLines(node);
    if (bs > s || be < e) continue;
    if (!best || be - bs < best.span) best = { node, span: be - bs };
  }
  return best ? best.node : null;
}

/** DOM Range for the nth whitespace-tolerant match of `quote` inside `scope`. */
function rangeForQuote(scope, quote, nth) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.data;
  }
  const matches = [...text.matchAll(wsRegex(quote))];
  const m = matches[Math.min(nth, matches.length - 1)];
  if (!m) return null;
  const at = (offset, preferEnd) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { node, start } = nodes[i];
      if (offset > start || (offset === start && !preferEnd) || i === 0) {
        return [node, Math.min(offset - start, node.data.length)];
      }
    }
    return null;
  };
  const range = document.createRange();
  range.setStart(...at(m.index, false));
  range.setEnd(...at(m.index + m[0].length, true));
  return range;
}

function nearestHeadingText(node) {
  for (let cur = node; cur; cur = cur.previousElementSibling || cur.parentElement) {
    if (cur !== node && /^H[1-6]$/.test(cur.tagName)) return cur.textContent.trim();
    if (cur.id === 'rendered-output') break;
  }
  return '';
}

function describeBlock(node) {
  const under = nearestHeadingText(node);
  const suffix = under ? ` under "${under}"` : '';
  const words = node.textContent.trim().split(/\s+/).slice(0, 5).join(' ');
  switch (node.tagName) {
    case 'CODE':
    case 'PRE': {
      // Fenced code blocks stamp <code>; indented code blocks stamp <pre> and
      // have no language class.
      const lang = (node.className.match(/language-(\S+)/) || [])[1];
      return { kind: 'code', label: `code block${lang ? `, ${lang}` : ''}${suffix}` };
    }
    case 'TABLE':
      return { kind: 'table', label: `table${suffix}` };
    case 'UL':
    case 'OL':
      return { kind: 'list', label: `list${suffix}` };
    case 'BLOCKQUOTE':
      return { kind: 'quote', label: `blockquote "${words}…"` };
    default:
      if (/^H[1-6]$/.test(node.tagName)) {
        return { kind: 'section', label: `section "${node.textContent.trim()}"` };
      }
      return { kind: 'paragraph', label: `paragraph "${words}…"` };
  }
}

export function initComments(deps) {
  const { root, scroller, rail, reviewBtn, copyBtn, api } = deps;
  let data = { round: 1, items: [] };
  let reviewing = false;
  let activeId = null;
  let popover = null;
  let gutterBtn = null;
  /** @type {Map<string, { range: Range|null, block: Element|null }>} */
  let targets = new Map();

  const note = () => deps.getNote();
  const base = () => `/api/files/${encodeURIComponent(note().id)}/comments`;

  // ── Resolve + paint ───────────────────────────────────────────────────────

  function resolveTargets() {
    targets = new Map();
    const source = deps.getSource();
    if (!source) return;
    for (const item of data.items) {
      if (!item.anchor) continue;
      const hit = locate(source, item.anchor);
      if (!hit) continue;
      const block = blockFor(root, hit.lines);
      let range = null;
      if (!item.anchor.block && block) {
        const nth =
          hit.start == null
            ? 0
            : nthInLines(source, parseLines(block), hit.start, item.anchor.quote);
        range = rangeForQuote(block, item.anchor.quote, nth);
      }
      targets.set(item.id, { range, block });
    }
  }

  function paintHighlights() {
    if (!canHighlight) return;
    for (const name of [...new Set(Object.values(HIGHLIGHT_FOR)), 'review-active']) {
      CSS.highlights.delete(name);
    }
    for (const node of root.querySelectorAll('.review-block'))
      node.classList.remove('review-block');
    if (!reviewing) return;
    const groups = {};
    for (const item of data.items) {
      const t = targets.get(item.id);
      if (!t || item.status !== 'open') continue;
      if (t.range) (groups[HIGHLIGHT_FOR[item.tag]] ||= []).push(t.range);
      if (item.id === activeId) {
        if (t.range) CSS.highlights.set('review-active', new Highlight(t.range));
        else if (t.block) t.block.classList.add('review-block');
      }
    }
    for (const [name, ranges] of Object.entries(groups)) {
      CSS.highlights.set(name, new Highlight(...ranges));
    }
  }

  function targetTop(item) {
    const t = targets.get(item.id);
    const rect =
      t && (t.range ? t.range.getBoundingClientRect() : t.block?.getBoundingClientRect());
    if (!rect) return null;
    return rect.top - scroller.getBoundingClientRect().top;
  }

  function renderRail() {
    rail.replaceChildren();
    rail.hidden = !reviewing;
    if (!reviewing) return;

    const general = data.items.find((i) => i.tag === 'general');
    const generalCard = el('div', { className: 'comment-card comments-general' }, [
      el('div', { className: 'comment-card-head', textContent: 'General note' }),
      el('div', {
        className: 'comment-card-note',
        textContent: general ? general.note : 'Add a note about the whole document',
      }),
    ]);
    generalCard.addEventListener('click', () => openComposer({ general }));
    rail.append(generalCard);

    const placed = data.items
      .filter((i) => i.anchor)
      .map((item) => ({ item, top: targetTop(item) }))
      .sort((a, b) => (a.top ?? Infinity) - (b.top ?? Infinity));
    let floor = generalCard.offsetTop + generalCard.offsetHeight + CARD_GAP;
    for (const { item, top } of placed) {
      const card = buildCard(item, top == null);
      rail.append(card);
      const y = Math.max(top ?? floor, floor);
      card.style.top = `${y}px`;
      floor = y + card.offsetHeight + CARD_GAP;
    }
    rail.style.height = `${floor}px`;
  }

  function buildCard(item, orphaned) {
    const quote = item.anchor.block ? `[${item.anchor.block.label}]` : `"${item.anchor.quote}"`;
    const card = el('div', { className: 'comment-card' }, [
      el('div', {
        className: 'comment-card-head',
        textContent: `${item.id} · ${item.tag}${orphaned ? ' · anchor not found' : ''} · ${quote}`,
      }),
    ]);
    card.dataset.id = item.id;
    card.dataset.tag = item.tag;
    card.classList.toggle('is-active', item.id === activeId);
    card.classList.toggle('is-addressed', item.status === 'addressed');
    if (item.replace) {
      card.append(el('div', { className: 'comment-card-note', textContent: `→ ${item.replace}` }));
    }
    if (item.note)
      card.append(el('div', { className: 'comment-card-note', textContent: item.note }));

    const action = (label, fn, danger) => {
      const b = el('button', {
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
        action('Edit', () => openComposer({ existing: item })),
        action(item.status === 'open' ? 'Resolve' : 'Reopen', () =>
          patch(item.id, { status: item.status === 'open' ? 'addressed' : 'open' })
        ),
        action('Delete', () => remove(item.id), true),
      ])
    );
    card.addEventListener('click', () => activate(item.id, { scroll: true }));
    return card;
  }

  function repaint() {
    resolveTargets();
    paintHighlights();
    renderRail();
    copyBtn.hidden = !(note() && note().owned && data.items.length);
  }

  function activate(id, { scroll = false } = {}) {
    activeId = id;
    paintHighlights();
    for (const card of rail.querySelectorAll('.comment-card[data-id]')) {
      card.classList.toggle('is-active', card.dataset.id === id);
    }
    const t = targets.get(id);
    const node = t && (t.range ? t.range.startContainer.parentElement : t.block);
    if (scroll && node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ── API ───────────────────────────────────────────────────────────────────

  async function create(body) {
    const res = await api(base(), { method: 'POST', body: JSON.stringify(body) });
    if (res.status === 409) {
      await load();
      throw new Error('The note changed. Select the text again.');
    }
    if (!res.ok) throw new Error((await res.json()).error || 'Could not save');
    const { item } = await res.json();
    data.items.push(item);
    activeId = item.id;
    repaint();
  }

  async function patch(id, body) {
    const res = await api(`${base()}/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not save');
    const { item } = await res.json();
    data.items = data.items.map((i) => (i.id === id ? item : i));
    repaint();
  }

  async function remove(id) {
    const res = await api(`${base()}/${id}`, { method: 'DELETE' });
    if (!res.ok) return;
    data.items = data.items.filter((i) => i.id !== id);
    if (activeId === id) activeId = null;
    repaint();
  }

  async function load() {
    data = { round: 1, items: [] };
    activeId = null;
    const current = note();
    if (current && current.owned) {
      try {
        const res = await api(base());
        if (res.ok && note() && note().id === current.id) data = await res.json();
      } catch {}
    }
    repaint();
  }

  // ── Composer popover ──────────────────────────────────────────────────────

  function closeComposer() {
    if (popover) popover.remove();
    popover = null;
  }

  /** opts: { anchor, rect } for new | { existing } to edit | { general } for the doc note. */
  function openComposer(opts) {
    closeComposer();
    const existing = opts.existing || opts.general || null;
    const isGeneral = 'general' in opts;
    let tag = existing ? existing.tag : isGeneral ? 'general' : 'fix';

    const tagRow = el('div', { className: 'comment-tags' });
    const tagButtons = TAGS.map((t, i) => {
      const b = el('button', { type: 'button', textContent: `${i + 1} ${t}` });
      b.addEventListener('click', () => setTag(t));
      tagRow.append(b);
      return b;
    });
    const noteInput = el('textarea', { rows: 2, placeholder: 'Add a note' });
    const replaceInput = el('input', {
      type: 'text',
      placeholder: 'Replace with (optional, exact)',
    });
    const error = el('span', { className: 'comment-error' });
    const foot = el('div', { className: 'comment-popover-foot' }, [
      el('span', { textContent: '⌘↵ save · esc cancel' }),
      error,
    ]);
    if (existing) {
      noteInput.value = existing.note || '';
      replaceInput.value = existing.replace || '';
    }
    // keep/general ids are fixed (see PATCH rules), so their tag cannot change.
    const tagLocked = isGeneral || (existing && existing.tag === 'keep');
    const hasQuote = !isGeneral && !(opts.anchor || existing.anchor).block;

    function setTag(next) {
      if (tagLocked || (existing && next === 'keep')) return;
      tag = next;
      tagButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(TAGS[i] === tag)));
      replaceInput.hidden = !(hasQuote && tag === 'fix');
    }

    popover = el('div', { className: 'comment-popover' }, [
      ...(tagLocked ? [] : [tagRow]),
      noteInput,
      replaceInput,
      foot,
    ]);
    setTag(tag);
    if (tagLocked) replaceInput.hidden = true;

    async function save() {
      const body = {
        note: noteInput.value,
        replace: replaceInput.hidden ? '' : replaceInput.value,
      };
      if (!NOTE_OPTIONAL.has(tag) && !body.note.trim() && !body.replace.trim()) {
        error.textContent = 'Add a note first';
        return;
      }
      try {
        if (existing) await patch(existing.id, tagLocked ? body : { ...body, tag });
        else await create({ ...body, tag, ...(isGeneral ? {} : { anchor: opts.anchor }) });
        closeComposer();
        window.getSelection().removeAllRanges();
      } catch (e) {
        error.textContent = e.message;
      }
    }

    popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeComposer();
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
      else if (!tagLocked && /^[1-4]$/.test(e.key) && (e.altKey || !noteInput.value)) {
        e.preventDefault();
        setTag(TAGS[Number(e.key) - 1]);
      }
    });

    scroller.append(popover);
    const host = scroller.getBoundingClientRect();
    const rect = opts.rect || rail.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left - host.left, 8), host.width - 316);
    popover.style.left = `${left}px`;
    popover.style.top = `${rect.bottom - host.top + 8}px`;
    noteInput.focus();
  }

  // ── Selection + gutter ────────────────────────────────────────────────────

  function closestBlock(node) {
    const e = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return e ? e.closest('[data-line]') : null;
  }

  function onSelectionEnd(e) {
    if (!reviewing || (popover && popover.contains(e.target))) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    const first = closestBlock(range.startContainer);
    const last = closestBlock(range.endContainer);
    if (!first || !last) return;
    const lines = [
      Math.min(parseLines(first)[0], parseLines(last)[0]),
      Math.max(parseLines(first)[1], parseLines(last)[1]),
    ];
    const anchor = captureAnchor(deps.getSource(), lines, sel.toString());
    if (!anchor.quote) return;
    openComposer({ anchor, rect: range.getBoundingClientRect() });
  }

  function onClick(e) {
    if (!reviewing) return;
    // The click that opens the composer (gutter "+" button, or the rail's
    // "General note" card) bubbles up to this document-level handler with a
    // collapsed selection; without this guard it would immediately close the
    // popover it just opened.
    if (rail.contains(e.target) || (gutterBtn && gutterBtn.contains(e.target))) return;
    if (popover && !popover.contains(e.target) && window.getSelection().isCollapsed)
      closeComposer();
    if (!root.contains(e.target) || !window.getSelection().isCollapsed) return;
    for (const item of data.items) {
      const t = targets.get(item.id);
      if (!t || !t.range) continue;
      const hit = [...t.range.getClientRects()].some(
        (r) =>
          e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      );
      if (hit) {
        activate(item.id);
        rail.querySelector(`[data-id="${item.id}"]`)?.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
  }

  function onHover(e) {
    if (!reviewing || popover) return;
    if (gutterBtn && gutterBtn.contains(e.target)) return;
    let block = e.target.closest ? e.target.closest('[data-line]') : null;
    // Comment on the outermost stamped block (a whole list or quote, not one item).
    while (block && block.parentElement.closest('[data-line]')) {
      block = block.parentElement.closest('[data-line]');
    }
    if (!block || !root.contains(block)) return;
    if (!gutterBtn) {
      gutterBtn = el('button', {
        className: 'comment-gutter-btn',
        type: 'button',
        textContent: '+',
        title: 'Comment on this block',
      });
      gutterBtn.setAttribute('aria-label', 'Comment on this block');
      gutterBtn.addEventListener('click', () => {
        const target = gutterBtn.block;
        const { kind, label } = describeBlock(target);
        openComposer({
          anchor: blockAnchor(parseLines(target), kind, label),
          rect: target.getBoundingClientRect(),
        });
      });
      scroller.append(gutterBtn);
    }
    const host = scroller.getBoundingClientRect();
    const rect = block.getBoundingClientRect();
    gutterBtn.block = block;
    gutterBtn.hidden = false;
    gutterBtn.style.top = `${rect.top - host.top}px`;
    gutterBtn.style.left = `${Math.max(rect.left - host.left - 30, 0)}px`;
  }

  // ── Mode + public API ─────────────────────────────────────────────────────

  function setReviewMode(on) {
    const next = Boolean(on && note() && note().owned);
    if (next === reviewing) return;
    reviewing = next;
    reviewBtn.setAttribute('aria-pressed', String(reviewing));
    scroller.classList.toggle('reviewing', reviewing);
    if (!reviewing) {
      closeComposer();
      if (gutterBtn) gutterBtn.hidden = true;
      activeId = null;
    }
    repaint();
    deps.onModeChange();
  }

  reviewBtn.addEventListener('click', () => setReviewMode(!reviewing));
  copyBtn.addEventListener('click', () => {
    const current = note();
    if (!current) return;
    const text = formatFeedback(data, deps.getSource(), {
      title: deps.getTitle(),
      rev: current.currentRev,
    });
    navigator.clipboard.writeText(text);
    deps.flashCopied(copyBtn);
  });
  document.addEventListener('mouseup', onSelectionEnd);
  document.addEventListener('click', onClick);
  root.addEventListener('mouseover', onHover);
  window.addEventListener('resize', () => reviewing && renderRail());

  return {
    load,
    clear() {
      data = { round: 1, items: [] };
      setReviewMode(false);
      repaint();
    },
    refresh: repaint,
    setReviewMode,
    isReviewing: () => reviewing,
  };
}
