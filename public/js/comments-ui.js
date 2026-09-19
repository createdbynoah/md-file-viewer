// public/js/comments-ui.js
// Review mode for the rendered note: select text (or a block) to comment,
// highlights via the CSS Custom Highlight API, a margin rail of cards, and
// "Copy feedback". All anchoring maths lives in anchor.js; this file is DOM glue.
import { captureAnchor, blockAnchor, locate, nthInLines, wsRegex } from './anchor.js';
import { formatFeedback, formatCriticMarkup } from './feedback-format.js';
import { el } from './el.js';
import { buildCard, buildGeneralCard } from './comments-cards.js';
import { buildComposer } from './comments-composer.js';
import { layoutFor, keyboardInset, summarize, summaryLabel, triageLabel } from './review-layout.js';

const HIGHLIGHT_FOR = {
  fix: 'review-fix',
  q: 'review-fix',
  keep: 'review-keep',
  cut: 'review-cut',
};
const CARD_GAP = 8;
const canHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS;
const TRIAGE_SEEN_CAP = 50;

/**
 * Keep at most the `TRIAGE_SEEN_CAP` most-recently-dismissed `triageSeen:*`
 * keys (value is the dismissal timestamp), dropping the oldest — same spirit
 * as scroll-memory.js's cap, so dismissals don't accumulate forever.
 */
function pruneTriageSeen() {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('triageSeen:')) continue;
    const at = Number(localStorage.getItem(key));
    entries.push([key, Number.isFinite(at) ? at : 0]);
  }
  entries.sort((a, b) => a[1] - b[1]);
  for (const [key] of entries.slice(0, Math.max(0, entries.length - TRIAGE_SEEN_CAP))) {
    localStorage.removeItem(key);
  }
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

/** Union of the line ranges of `nodes`, or null when there are none. */
function unionLines(nodes) {
  if (!nodes.length) return null;
  return nodes.reduce(
    ([s, e], node) => {
      const [bs, be] = parseLines(node);
      return [Math.min(s, bs), Math.max(e, be)];
    },
    [Infinity, -Infinity]
  );
}

/**
 * The element(s) whose rendered text a quote for `lines` should be searched in:
 * the single smallest block covering the range when there is one, otherwise the
 * top-level stamped blocks the range touches (a selection running from one
 * paragraph into the next heading has no single covering block).
 * @returns {Element[]}
 */
function blockScopes(root, [s, e]) {
  const covering = blockFor(root, [s, e]);
  if (covering) return [covering];
  const out = [];
  for (const node of root.querySelectorAll('[data-line]')) {
    if (node.parentElement && node.parentElement.closest('[data-line]')) continue;
    const [bs, be] = parseLines(node);
    if (be < s || bs > e) continue;
    out.push(node);
  }
  return out;
}

// Blocks are separated by a newline in the concatenated text so a quote that
// spans two of them still matches (source has a blank line there; the DOM has
// nothing between the two text nodes).
const SCOPE_GAP = '\n';

/** Text nodes of `scopes` in document order, with offsets into their concatenation. */
function textMap(scopes) {
  const nodes = [];
  let text = '';
  for (const scope of scopes) {
    if (text) text += SCOPE_GAP;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: text.length });
      text += n.data;
    }
  }
  return { nodes, text };
}

/** Offset of a DOM point within `map`'s concatenated text, or null. */
function offsetOfPoint(map, container, offset) {
  if (container.nodeType === Node.TEXT_NODE) {
    const entry = map.nodes.find((n) => n.node === container);
    return entry ? entry.start + offset : null;
  }
  const child = container.childNodes[offset] || container.lastChild;
  if (!child) return null;
  const entry = map.nodes.find((n) => n.node === child || child.contains(n.node));
  return entry ? entry.start : null;
}

/**
 * 0-based index of the occurrence starting at a DOM point among the matches of
 * `quote` in `scopes` — the rendered-side twin of `nthInLines`, so a repeated
 * phrase anchors to the occurrence the user actually selected.
 */
function occurrenceAt(scopes, quote, container, offset) {
  if (!quote.trim()) return 0;
  const map = textMap(scopes);
  const at = offsetOfPoint(map, container, offset);
  if (at == null) return 0;
  return [...map.text.matchAll(wsRegex(quote))].filter((m) => m.index < at).length;
}

/** DOM Range for the nth whitespace-tolerant match of `quote` across `scopes`. */
function rangeForQuote(scopes, quote, nth) {
  const { nodes, text } = textMap(scopes);
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

/** The outermost stamped block containing `target` (a whole list, not one item). */
function outermostBlock(root, target) {
  let block = target && target.closest ? target.closest('[data-line]') : null;
  while (block && block.parentElement.closest('[data-line]')) {
    block = block.parentElement.closest('[data-line]');
  }
  return block && root.contains(block) ? block : null;
}

export function initComments(deps) {
  const {
    root,
    scroller,
    rail,
    drawer,
    listBtn,
    reviewBtn,
    copyBtn,
    banner,
    copyMenuBtn,
    copyMenu,
    api,
  } = deps;
  const drawerList = drawer.querySelector('.comments-list');
  const coarse = window.matchMedia('(pointer: coarse)');
  let data = { round: 1, items: [] };
  let addressedOpen = false;
  // True while load() has an in-flight fetch; the public refresh() no-ops
  // during this window so a caller's own render (e.g. app.js re-rendering the
  // note on save, before the re-triaged comments are back) never repaints
  // stale comments against the new source — load()'s own repaint() at the
  // end runs unconditionally once the fetch settles.
  let loading = false;
  let reviewing = false;
  let activeId = null;
  let popover = null; // composer or item view, rail/drawer layouts
  let composing = false;
  // Bumped by every openComposer so a save that resolves late can tell whether
  // the composer it belongs to is still the one on screen.
  let composerToken = 0;
  let composerView = null; // { composer, title, quoted } while a composer is open
  let sheet = null; // bottom sheet, sheet layout
  let sheetKind = null; // 'composer' | 'item' | 'list'
  let sheetBody = null;
  let gutterBtn = null;
  let gutterBlock = null;
  let pill = null;
  let pending = null; // { anchor, rect } captured while the selection existed
  let pendingBlock = null;
  let bar = null;
  let barSummary = null;
  let selectionTimer = 0;
  let currentLayout = layoutFor(window.innerWidth);
  let lastWidth = window.innerWidth;
  /** @type {Map<string, { range: Range|null, block: Element|null, lines: [number, number] }>} */
  let targets = new Map();

  const note = () => deps.getNote();
  const base = () => `/api/files/${encodeURIComponent(note().id)}/comments`;
  const layout = () => layoutFor(window.innerWidth);
  const active = () => reviewing && deps.canReview();
  // Touch selection never produces a usable mouseup, and on a phone a popover
  // would sit under the native selection callout — both get the pill instead.
  const usesPill = () => coarse.matches || layout() === 'sheet';

  // ── Resolve + paint ───────────────────────────────────────────────────────

  function resolveTargets() {
    targets = new Map();
    const source = deps.getSource();
    if (!source) return;
    for (const item of data.items) {
      if (!item.anchor) continue;
      const hit = locate(source, item.anchor);
      if (!hit) continue;
      const scopes = blockScopes(root, hit.lines);
      const block = blockFor(root, hit.lines) || scopes[0] || null;
      let range = null;
      if (!item.anchor.block && scopes.length) {
        const nth =
          hit.start == null
            ? 0
            : nthInLines(source, unionLines(scopes), hit.start, item.anchor.quote);
        range = rangeForQuote(scopes, item.anchor.quote, nth);
      }
      targets.set(item.id, { range, block, lines: hit.lines });
    }
  }

  function paintHighlights() {
    if (canHighlight) {
      for (const name of [...new Set(Object.values(HIGHLIGHT_FOR)), 'review-active']) {
        CSS.highlights.delete(name);
      }
    }
    for (const node of root.querySelectorAll('.review-block'))
      node.classList.remove('review-block');
    if (!active()) return;
    if (pendingBlock) pendingBlock.classList.add('review-block');
    const groups = {};
    for (const item of data.items) {
      const t = targets.get(item.id);
      if (!t || item.status !== 'open') continue;
      if (t.range) (groups[HIGHLIGHT_FOR[item.tag]] ||= []).push(t.range);
      if (item.id === activeId) {
        if (canHighlight && t.range) CSS.highlights.set('review-active', new Highlight(t.range));
        else if (t.block) t.block.classList.add('review-block');
      }
    }
    if (canHighlight) {
      for (const [name, ranges] of Object.entries(groups)) {
        CSS.highlights.set(name, new Highlight(...ranges));
      }
    }
  }

  // ── Lists: rail (positioned), drawer and list sheet (document order) ──────

  function cardFor(item, orphaned, isActive = item.id === activeId) {
    return buildCard(item, {
      orphaned,
      active: isActive,
      onActivate: () => {
        // In a sheet the note is underneath: get out of the way, then scroll.
        if (layout() === 'sheet') closeFloating();
        activate(item.id, { scroll: true });
      },
      onEdit: () => openComposer({ existing: item }),
      onToggle: () =>
        patch(item.id, { status: item.status === 'open' ? 'addressed' : 'open' }).catch(() => {}),
      onDelete: () => remove(item.id),
      diffWords: deps.diffWords,
      onAccept: () => remove(item.id),
    });
  }

  /** Violated keeps first, then live items by position; addressed go to the disclosure. */
  function partition() {
    const anchored = data.items.filter((i) => i.anchor);
    return {
      violated: anchored.filter((i) => i.status === 'violated'),
      live: anchored.filter((i) => i.status === 'open'),
      addressed: anchored.filter((i) => i.status === 'addressed'),
    };
  }

  function addressedDisclosure(addressed) {
    const details = el('details', { className: 'comments-addressed', open: addressedOpen }, [
      el('summary', { textContent: `${addressed.length} addressed` }),
      ...addressed.map((item) => cardFor(item, false, false)),
    ]);
    details.addEventListener('toggle', () => {
      // Creating it with `open` set fires a toggle too; only a real change may
      // re-render, or the rebuild below would loop.
      if (details.open === addressedOpen) return;
      addressedOpen = details.open;
      if (layout() === 'rail') renderList(); // re-measure: the rail's height is explicit
    });
    return details;
  }

  function targetTop(item) {
    const t = targets.get(item.id);
    const rect =
      t && (t.range ? t.range.getBoundingClientRect() : t.block?.getBoundingClientRect());
    if (!rect) return null;
    return rect.top - scroller.getBoundingClientRect().top;
  }

  function renderRail() {
    const { violated, live, addressed } = partition();
    const general = data.items.find((i) => i.tag === 'general');
    const generalCard = buildGeneralCard(general, () => openComposer({ general }));
    rail.append(generalCard);
    let floor = generalCard.offsetTop + generalCard.offsetHeight + CARD_GAP;
    const place = (card, top) => {
      rail.append(card);
      const y = Math.max(top ?? floor, floor);
      card.style.top = `${y}px`;
      floor = y + card.offsetHeight + CARD_GAP;
    };
    // Violated keeps are pinned under the general note, not at their (gone) anchor.
    for (const item of violated) place(cardFor(item, false), null);
    const placed = live
      .map((item) => ({ item, top: targetTop(item), orphaned: !targets.has(item.id) }))
      .sort((a, b) => (a.top ?? Infinity) - (b.top ?? Infinity));
    for (const { item, top, orphaned } of placed) place(cardFor(item, orphaned), top);
    if (addressed.length) {
      const details = addressedDisclosure(addressed);
      details.style.position = 'absolute';
      details.style.left = '0';
      details.style.right = '0';
      details.style.top = `${floor}px`;
      rail.append(details);
      floor += details.offsetHeight + CARD_GAP;
    }
    rail.style.height = `${floor}px`;
  }

  function renderFlatList(host) {
    const { violated, live, addressed } = partition();
    const general = data.items.find((i) => i.tag === 'general');
    host.append(buildGeneralCard(general, () => openComposer({ general })));
    for (const item of violated) host.append(cardFor(item, false));
    const line = (item) => targets.get(item.id)?.lines[0] ?? Infinity;
    for (const item of [...live].sort((a, b) => line(a) - line(b))) {
      host.append(cardFor(item, !targets.has(item.id)));
    }
    if (addressed.length) host.append(addressedDisclosure(addressed));
    if (host === sheetBody) {
      const more = (label, fn) => {
        const b = el('button', { type: 'button', className: 'text-btn', textContent: label });
        b.addEventListener('click', () => fn(b));
        return b;
      };
      host.append(
        el('div', { className: 'review-sheet-copy' }, [
          more('Copy incl. addressed', (b) => copyFeedback(b, 'addressed')),
          more('Copy inline (CriticMarkup)', (b) => copyFeedback(b, 'critic')),
        ])
      );
    }
  }

  function renderList() {
    const mode = layout();
    rail.replaceChildren();
    drawerList.replaceChildren();
    rail.hidden = !(active() && mode === 'rail');
    const count = data.items.length;
    listBtn.hidden = !(active() && mode === 'drawer');
    listBtn.textContent = count ? `Comments · ${count}` : 'Comments';
    if (!active() || mode !== 'drawer') setDrawer(false);
    if (!active()) return;
    if (mode === 'rail') renderRail();
    else if (mode === 'drawer' && !drawer.hidden) renderFlatList(drawerList);
    else if (mode === 'sheet' && sheetKind === 'list') {
      sheetBody.replaceChildren();
      renderFlatList(sheetBody);
    }
  }

  function setDrawer(open) {
    drawer.hidden = !open;
    listBtn.setAttribute('aria-expanded', String(open));
  }

  // ── Review bar (sheet layout) ─────────────────────────────────────────────

  function renderBar() {
    const show = active() && layout() === 'sheet';
    if (!bar) {
      if (!show) return;
      barSummary = el('button', { type: 'button', className: 'text-btn review-bar-summary' });
      barSummary.addEventListener('click', () => {
        if (sheetKind === 'list') return closeFloating();
        openSheet('list', 'Comments', []);
        renderList();
      });
      const copy = el('button', {
        type: 'button',
        className: 'text-btn',
        textContent: 'Copy feedback',
      });
      copy.addEventListener('click', () => copyFeedback(copy));
      const done = el('button', { type: 'button', className: 'primary-btn', textContent: 'Done' });
      done.addEventListener('click', () => setReviewMode(false));
      bar = el('div', { className: 'review-bar' }, [barSummary, copy, done]);
      // Before the pill in DOM order: the pill's CSS lifts it above a shown bar.
      document.body.insertBefore(bar, pill);
    }
    bar.hidden = !show;
    if (show) barSummary.textContent = summaryLabel(summarize(data.items));
  }

  // Skips the DOM rebuild (and so a screen reader re-announce of the
  // role="status" region) when the computed banner state hasn't changed —
  // e.g. a resize-triggered repaint while reviewing.
  let bannerKey = null;

  function renderBanner() {
    const current = note();
    const t = data.lastTriage;
    const seenKey = current && t ? `triageSeen:${current.id}:${t.rev}` : null;
    let seen = false;
    try {
      seen = Boolean(seenKey && localStorage.getItem(seenKey));
    } catch {}
    const unverified = Boolean(
      current &&
      data.items.some(
        (i) => i.anchor && typeof i.rev === 'number' && i.rev < (current.currentRev || 0)
      )
    );
    const showRound = Boolean(t && current && t.rev === current.currentRev && !seen);
    const hidden = !(active() && (showRound || unverified));
    const text = hidden
      ? ''
      : showRound
        ? triageLabel(t)
        : 'Comments were not re-checked against this revision; positions may be stale.';
    const violated = Boolean(showRound && t && t.violated);
    // `seenKey` folds in the note id + triaged rev, so a note switch that
    // happens to land on the same hidden/text/violated combo still rebuilds
    // (and rebinds Dismiss to the new note's key) instead of being skipped.
    const key = JSON.stringify([seenKey, hidden, text, violated, showRound]);
    if (key === bannerKey) return;
    bannerKey = key;
    banner.replaceChildren();
    banner.hidden = hidden;
    if (hidden) return;
    banner.classList.toggle('has-violations', violated);
    banner.append(el('span', { className: 'review-banner-text', textContent: text }));
    if (showRound) {
      const dismiss = el('button', {
        type: 'button',
        className: 'text-btn',
        textContent: 'Dismiss',
      });
      dismiss.addEventListener('click', () => {
        try {
          localStorage.setItem(seenKey, String(Date.now()));
          pruneTriageSeen();
        } catch {}
        // Not renderBanner() alone: hiding the banner reflows the article, so
        // the rail needs to re-measure against the new layout too.
        repaint();
      });
      banner.append(dismiss);
    }
  }

  function repaint() {
    // An item view shows a snapshot of one comment; anything that repaints may
    // have changed it. The composer holds unsaved input, so it is left alone.
    if (!composing) closeFloating({ keepList: true });
    resolveTargets();
    paintHighlights();
    // Before renderList(): showing/hiding the banner reflows the article (a
    // normal-flow sibling above it), which moves every anchor's rect. The
    // rail measures those rects while placing cards, so the banner's final
    // hidden state must land first or every card is off by the banner's height.
    renderBanner();
    renderList();
    renderBar();
    copyBtn.hidden = !(note() && note().owned && data.items.length);
    copyMenuBtn.hidden = copyBtn.hidden;
  }

  function activate(id, { scroll = false } = {}) {
    activeId = id;
    paintHighlights();
    for (const card of document.querySelectorAll('.comment-card[data-id]')) {
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
      // The source we anchored against is stale; reload the whole note (which
      // also reloads comments and drops review mode), then re-enter review.
      const wasReviewing = reviewing;
      closeFloating();
      await deps.reloadNote();
      if (wasReviewing) setReviewMode(true);
      window.alert('The note changed and was reloaded. Select the text again.');
      return;
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save');
    const { item } = await res.json();
    data.items.push(item);
    activeId = item.id;
    repaint();
  }

  async function patch(id, body) {
    const res = await api(`${base()}/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save');
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
    loading = true;
    data = { round: 1, items: [] };
    activeId = null;
    addressedOpen = false;
    copyBtn.hidden = true;
    const current = note();
    if (current && current.owned) {
      try {
        const res = await api(base());
        if (res.ok && note() && note().id === current.id) data = await res.json();
      } catch {}
    }
    loading = false;
    repaint();
  }

  /** mode: undefined (open only) | 'addressed' | 'critic' */
  function copyFeedback(flashOn, mode) {
    const current = note();
    if (!current) return;
    const source = deps.getSource();
    const text =
      mode === 'critic'
        ? formatCriticMarkup(data, source)
        : formatFeedback(
            data,
            source,
            { title: deps.getTitle(), rev: current.currentRev },
            { includeAddressed: mode === 'addressed' }
          );
    navigator.clipboard
      .writeText(text)
      .then(() => deps.flashCopied(flashOn))
      .catch(() => {});
  }

  // ── Floating UI: popover (≥768) and bottom sheet (<768) ───────────────────

  function syncInset() {
    if (!sheet) return;
    const vv = window.visualViewport;
    const inset = vv
      ? keyboardInset({
          innerHeight: window.innerHeight,
          vvHeight: vv.height,
          vvOffsetTop: vv.offsetTop,
          scale: vv.scale,
        })
      : 0;
    document.documentElement.style.setProperty('--kb-inset', `${inset}px`);
  }

  function openSheet(kind, title, children) {
    closeFloating();
    const close = el('button', { type: 'button', className: 'text-btn', textContent: 'Close' });
    close.addEventListener('click', () => closeFloating());
    sheetBody = el('div', { className: 'review-sheet-body' }, children);
    sheet = el('div', { className: 'review-sheet' }, [
      el('div', { className: 'review-sheet-head' }, [el('span', { textContent: title }), close]),
      sheetBody,
    ]);
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', title);
    sheet.dataset.kind = kind;
    sheetKind = kind;
    document.body.append(sheet);
    syncInset();
  }

  function openPopover(children, rect) {
    popover = el('div', { className: 'comment-popover' }, children);
    scroller.append(popover);
    const host = scroller.getBoundingClientRect();
    const at = rect || (rail.hidden ? listBtn : rail).getBoundingClientRect();
    const left = Math.min(Math.max(at.left - host.left, 8), host.width - 316);
    popover.style.left = `${left}px`;
    popover.style.top = `${at.bottom - host.top + 8}px`;
  }

  /** Close the popover and any sheet; `keepList` leaves an open list sheet up. */
  function closeFloating({ keepList = false } = {}) {
    if (popover) popover.remove();
    popover = null;
    if (sheet && !(keepList && sheetKind === 'list')) {
      sheet.remove();
      sheet = null;
      sheetKind = null;
      sheetBody = null;
      document.documentElement.style.setProperty('--kb-inset', '0px');
    }
    composing = false;
    composerView = null;
  }

  /** Put the composer into the current layout's container (sheet or popover). */
  function presentComposer(view, rect) {
    if (layout() === 'sheet')
      openSheet('composer', view.title, [...view.quoted, view.composer.node]);
    else openPopover([view.composer.node], rect);
    // openSheet() starts with closeFloating(), which clears these — set them last.
    composerView = view;
    composing = true;
    view.composer.focus();
  }

  /** opts: { anchor, rect } for new | { existing } to edit | { general } for the doc note. */
  function openComposer(opts) {
    closeFloating();
    hidePill();
    const existing = opts.existing || opts.general || null;
    const isGeneral = 'general' in opts;
    const token = ++composerToken;
    const composer = buildComposer({
      existing,
      isGeneral,
      anchor: opts.anchor || null,
      onCancel: () => closeFloating(),
      onSubmit: async ({ body, tag, tagLocked }) => {
        if (existing) await patch(existing.id, tagLocked ? body : { ...body, tag });
        else await create({ ...body, tag, ...(isGeneral ? {} : { anchor: opts.anchor }) });
        // The user may have cancelled this composer and opened another while
        // the save was in flight; don't tear that one down.
        if (token !== composerToken) return;
        closeFloating();
        window.getSelection().removeAllRanges();
      },
    });
    const target = opts.anchor || (existing && existing.anchor) || null;
    const quoted = target
      ? [
          el('p', {
            className: 'review-sheet-quote',
            textContent: target.block ? `[${target.block.label}]` : target.quote,
          }),
        ]
      : [];
    presentComposer({ composer, title: isGeneral ? 'General note' : 'Comment', quoted }, opts.rect);
  }

  /** Tap on a highlight where there is no rail: show that one comment. */
  function openItem(item, rect) {
    closeFloating();
    activate(item.id);
    const card = cardFor(item, false, true);
    if (layout() === 'sheet') openSheet('item', `${item.id} · ${item.tag}`, [card]);
    else openPopover([card], rect);
  }

  // ── Selection, pill, gutter ───────────────────────────────────────────────

  function closestBlock(node) {
    const e = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return e ? e.closest('[data-line]') : null;
  }

  /** The current selection as { anchor, rect }, or null when it is not commentable. */
  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    const first = closestBlock(range.startContainer);
    const last = closestBlock(range.endContainer);
    if (!first || !last) return null;
    const spanned = [
      Math.min(parseLines(first)[0], parseLines(last)[0]),
      Math.max(parseLines(first)[1], parseLines(last)[1]),
    ];
    const scopes = blockScopes(root, spanned);
    const lines = unionLines(scopes) || spanned;
    const text = sel.toString();
    const nth = occurrenceAt(scopes, text, range.startContainer, range.startOffset);
    const anchor = captureAnchor(deps.getSource(), lines, text, nth);
    return anchor.quote ? { anchor, rect: range.getBoundingClientRect() } : null;
  }

  function showPill(label, capture, block = null) {
    pending = capture;
    pendingBlock = block;
    pill.textContent = label;
    pill.hidden = false;
    paintHighlights();
  }

  function hidePill() {
    pending = null;
    const hadBlock = pendingBlock;
    pendingBlock = null;
    if (pill) pill.hidden = true;
    if (hadBlock) paintHighlights();
  }

  function onSelectionChange() {
    clearTimeout(selectionTimer);
    // Handles are still being dragged while this fires; wait for them to settle.
    selectionTimer = setTimeout(() => {
      if (!active() || !usesPill() || composing) return;
      const capture = captureSelection();
      if (capture) showPill('Comment', capture);
      else if (!pendingBlock) hidePill();
    }, 200);
  }

  function onSelectionEnd(e) {
    if (!active() || usesPill() || isChrome(e.target)) return;
    const capture = captureSelection();
    if (capture) openComposer(capture);
  }

  function isChrome(target) {
    return [
      rail,
      drawer,
      listBtn,
      gutterBtn,
      popover,
      sheet,
      bar,
      pill,
      copyMenuBtn,
      copyMenu,
      banner,
    ].some((node) => node && node.contains(target));
  }

  /**
   * A click inside the rendered note. Registered on `root` rather than left to
   * the document listener: iOS only delivers synthesized clicks from `document`
   * for nodes it considers clickable, and note prose is not one of them.
   */
  function onNoteClick(e) {
    if (!active() || isChrome(e.target)) return;
    if (!window.getSelection().isCollapsed) return;
    // A composer in a sheet covers the note; a tap through to it would open an
    // item view or a block pill and silently drop the unsaved draft.
    if (composing && sheetKind === 'composer') return;
    if (popover) closeFloating();
    for (const item of data.items) {
      const t = targets.get(item.id);
      if (!t || !t.range || item.status !== 'open') continue;
      const rects = [...t.range.getClientRects()];
      const hit = rects.some(
        (r) =>
          e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      );
      if (!hit) continue;
      hidePill();
      if (layout() === 'rail') {
        activate(item.id);
        rail.querySelector(`[data-id="${item.id}"]`)?.scrollIntoView({ block: 'nearest' });
      } else {
        openItem(item, rects[rects.length - 1]);
      }
      return;
    }
    // Touch has no hover, so a plain tap on a block offers the block comment.
    if (!usesPill()) return;
    if (e.target.closest && e.target.closest('a, button, input, textarea, select, summary')) {
      return hidePill();
    }
    const block = outermostBlock(root, e.target);
    if (!block || block === pendingBlock) return hidePill();
    const { kind, label } = describeBlock(block);
    showPill(
      'Comment on block',
      { anchor: blockAnchor(parseLines(block), kind, label), rect: block.getBoundingClientRect() },
      block
    );
  }

  /**
   * A click anywhere outside the note: drop the pill and close a popover
   * composer/item view. In-note clicks bubble here too, so they are skipped —
   * `root`'s own listener has already handled them.
   */
  function onOutsideClick(e) {
    if (!active() || isChrome(e.target) || root.contains(e.target)) return;
    if (!window.getSelection().isCollapsed) return;
    if (popover) closeFloating();
    hidePill();
  }

  function onHover(e) {
    if (!active() || popover || usesPill() || layout() !== 'rail') return;
    if (gutterBtn && gutterBtn.contains(e.target)) return;
    const block = outermostBlock(root, e.target);
    if (!block) return;
    if (!gutterBtn) {
      gutterBtn = el('button', {
        className: 'comment-gutter-btn',
        type: 'button',
        textContent: '+',
        title: 'Comment on this block',
      });
      gutterBtn.setAttribute('aria-label', 'Comment on this block');
      gutterBtn.addEventListener('click', () => {
        if (!gutterBlock || !gutterBlock.isConnected) return;
        const { kind, label } = describeBlock(gutterBlock);
        openComposer({
          anchor: blockAnchor(parseLines(gutterBlock), kind, label),
          rect: gutterBlock.getBoundingClientRect(),
        });
      });
      scroller.append(gutterBtn);
    }
    const host = scroller.getBoundingClientRect();
    const rect = block.getBoundingClientRect();
    gutterBlock = block;
    gutterBtn.hidden = false;
    gutterBtn.style.top = `${rect.top - host.top}px`;
    gutterBtn.style.left = `${Math.max(rect.left - host.left - 30, 0)}px`;
  }

  // ── Mode + public API ─────────────────────────────────────────────────────

  function setReviewMode(on) {
    const next = Boolean(on && note() && note().owned && deps.canReview());
    if (next === reviewing) return;
    reviewing = next;
    reviewBtn.setAttribute('aria-pressed', String(reviewing));
    scroller.classList.toggle('reviewing', reviewing);
    if (!reviewing) {
      closeFloating();
      hidePill();
      setDrawer(false);
      closeCopyMenu();
      if (gutterBtn) gutterBtn.hidden = true;
      activeId = null;
    }
    repaint();
    deps.onModeChange();
  }

  function onResize() {
    // A mobile URL-bar collapse/expand fires resize without changing width;
    // don't drop an open item sheet/popover or reposition the rail for that.
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    const next = layout();
    if (next !== currentLayout) {
      // Rotation or a window resize across a breakpoint: stay in review mode,
      // drop floating UI that belongs to the old layout. An open composer's
      // unsaved draft is re-presented in the new layout's container instead
      // of dropped.
      currentLayout = next;
      // Move an open composer (and its unsaved draft) into the new layout's
      // container; the same DOM node is re-parented, so nothing typed is lost.
      const view = composerView;
      closeFloating();
      if (view) presentComposer(view);
      hidePill();
      setDrawer(false);
      if (gutterBtn) gutterBtn.hidden = true;
    }
    if (reviewing) repaint();
  }

  pill = el('button', { type: 'button', className: 'comment-pill', hidden: true });
  // Keep the text selection alive through the tap; the anchor was captured
  // when the selection settled, so nothing depends on it surviving the click.
  pill.addEventListener('pointerdown', (e) => e.preventDefault());
  pill.addEventListener('click', () => {
    const capture = pending;
    if (capture) openComposer(capture);
  });
  document.body.append(pill);

  function closeCopyMenu() {
    copyMenu.hidden = true;
    copyMenuBtn.setAttribute('aria-expanded', 'false');
  }

  reviewBtn.addEventListener('click', () => setReviewMode(!reviewing));
  copyBtn.addEventListener('click', () => copyFeedback(copyBtn));
  copyMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!copyMenu.hidden) return closeCopyMenu();
    // The folder dropdown and ••• menu each stop propagation on their own
    // opener, so the outside-click listener that would otherwise close them
    // never fires; close them ourselves instead.
    deps.closeOtherMenus?.();
    copyMenu.replaceChildren(
      ...[
        ['Open only', undefined],
        ['Include addressed', 'addressed'],
        ['Inline (CriticMarkup)', 'critic'],
      ].map(([label, mode]) => {
        const b = el('button', {
          type: 'button',
          className: 'folder-dropdown-item',
          textContent: label,
        });
        b.setAttribute('role', 'menuitem');
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeCopyMenu();
          copyFeedback(copyBtn, mode);
        });
        return b;
      })
    );
    copyMenu.hidden = false;
    copyMenuBtn.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('click', closeCopyMenu);
  const onCopyMenuKeydown = (e) => {
    if (e.key !== 'Escape' || copyMenu.hidden) return;
    closeCopyMenu();
    copyMenuBtn.focus();
  };
  copyMenuBtn.addEventListener('keydown', onCopyMenuKeydown);
  copyMenu.addEventListener('keydown', onCopyMenuKeydown);
  listBtn.addEventListener('click', () => {
    setDrawer(drawer.hidden);
    renderList();
  });
  document.addEventListener('mouseup', onSelectionEnd);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('click', onOutsideClick);
  root.addEventListener('click', onNoteClick);
  root.addEventListener('mouseover', onHover);
  window.addEventListener('resize', onResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncInset);
    window.visualViewport.addEventListener('scroll', syncInset);
  }

  return {
    load,
    /**
     * Drop the note's comments and every piece of review chrome. The pill, bar
     * and sheets live on document.body, so this must run on every path that
     * leaves the note or the app (including showLogin) — `setReviewMode(false)`
     * alone no-ops when review mode was never on.
     */
    clear() {
      data = { round: 1, items: [] };
      setReviewMode(false);
      closeFloating();
      hidePill();
      setDrawer(false);
      closeCopyMenu();
      if (gutterBtn) gutterBtn.hidden = true;
      activeId = null;
      addressedOpen = false;
      repaint();
    },
    // No-ops while a load() fetch is in flight — see `loading` above.
    refresh: () => {
      if (!loading) repaint();
    },
    setReviewMode,
    isReviewing: () => reviewing,
  };
}
