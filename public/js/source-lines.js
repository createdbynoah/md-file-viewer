// markdown-it plugin: stamp each rendered block with the 1-based inclusive
// source line range it came from, so a DOM selection can be mapped back to the
// raw markdown (see anchor.js). Fenced code blocks carry the attribute on <code>;
// indented code blocks on <pre> (markdown-it's default renderers).
export function sourceLines(md) {
  md.core.ruler.push('source_lines', (state) => {
    for (const token of state.tokens) {
      if (!token.map || !token.block || token.nesting === -1 || token.type === 'inline') continue;
      token.attrSet('data-line', `${token.map[0] + 1},${token.map[1]}`);
    }
  });
}
