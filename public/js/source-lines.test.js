import { describe, it, expect } from 'vitest';
import markdownit from 'markdown-it';
import { sourceLines } from './source-lines.js';

const md = markdownit({ html: true }).use(sourceLines);
const SRC = [
  '# Title',
  '',
  'Para one',
  'still one.',
  '',
  '- a',
  '- b',
  '',
  '```js',
  'x()',
  '```',
].join('\n');

describe('sourceLines', () => {
  const html = md.render(SRC);
  it('stamps 1-based inclusive ranges on blocks', () => {
    expect(html).toContain('<h1 data-line="1,1">');
    expect(html).toContain('<p data-line="3,4">');
    expect(html).toContain('<ul data-line="6,8">');
    expect(html).toContain('<li data-line="6,6">');
  });
  it('stamps fenced code on the code element', () => {
    expect(html).toMatch(
      /<code class="language-js" data-line="9,11">|<code data-line="9,11" class="language-js">/
    );
  });
  it('does not stamp closing or inline tokens', () => {
    expect(html).not.toContain('</p data-line');
    expect(md.renderInline('a *b*')).not.toContain('data-line');
  });
});
