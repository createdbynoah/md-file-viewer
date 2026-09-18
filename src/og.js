// Pure helpers for per-note Open Graph tags (see the SPA fallback in worker.js).

const UUID_RE = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SHORT_ID_RE = /^\/([0-9a-z]{25})$/i;
const UUID_LIMIT = 1n << 128n;
const SHORT_ID_LENGTH = 25;

export const EXCERPT_MAX = 160;

/** Note path (`/<base36>` or legacy `/<uuid>`) → storage uuid, or null. */
export function pathToUuid(path) {
  const legacy = UUID_RE.exec(path);
  if (legacy) return legacy[1].toLowerCase();
  const short = SHORT_ID_RE.exec(path);
  if (!short) return null;
  let n = 0n;
  for (const ch of short[1].toLowerCase()) {
    n = n * 36n + BigInt(parseInt(ch, 36));
  }
  if (n >= UUID_LIMIT) return null;
  const hex = n.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidToShortId(uuid) {
  return BigInt('0x' + uuid.replace(/-/g, ''))
    .toString(36)
    .padStart(SHORT_ID_LENGTH, '0');
}

/** Plain-text preview of a markdown string, cut on a word boundary. */
export function excerpt(markdown, max = EXCERPT_MAX) {
  const text = markdown
    .replace(/^(```|~~~)[\s\S]*?(^\1.*$|(?![\s\S]))/gm, ' ') // fenced code, closed or cut off
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
    .replace(/<[^>]+>/g, ' ') // html tags
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '') // block markers
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ') // horizontal rules
    .replace(/(\*\*|__|\*|_|~~|`)/g, '') // emphasis / inline code
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut) + '…';
}
