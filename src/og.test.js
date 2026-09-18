import { describe, it, expect } from 'vitest';
import { excerpt, pathToUuid, uuidToShortId } from './og.js';

describe('excerpt', () => {
  it('strips headings, emphasis, links, images and inline code', () => {
    const md =
      '# Title\n\nSome **bold** and _em_ with [a link](https://x.test) ![img](a.png) and `code`.';
    expect(excerpt(md)).toBe('Title Some bold and em with a link and code.');
  });

  it('drops fenced code blocks, html tags, quotes and list markers', () => {
    const md = '> quoted\n\n```js\nconst secret = 1;\n```\n\n- one\n* two\n1. three\n<b>html</b>';
    expect(excerpt(md)).toBe('quoted one two three html');
  });

  it('drops an unterminated fence (ranged read can cut one in half)', () => {
    expect(excerpt('intro\n\n```js\nconst a = 1;')).toBe('intro');
  });

  it('truncates on a word boundary with an ellipsis', () => {
    const out = excerpt('word '.repeat(100));
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('word…')).toBe(true);
  });

  it('returns empty string for empty or markup-only content', () => {
    expect(excerpt('')).toBe('');
    expect(excerpt('```\nx\n```')).toBe('');
  });
});

describe('pathToUuid', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';

  it('round-trips a short id', () => {
    expect(pathToUuid(`/${uuidToShortId(uuid)}`)).toBe(uuid);
  });

  it('accepts a legacy uuid path, lowercased', () => {
    expect(pathToUuid(`/${uuid.toUpperCase()}`)).toBe(uuid);
  });

  it('rejects overflow and other paths', () => {
    expect(pathToUuid('/zzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
    expect(pathToUuid('/about')).toBeNull();
    expect(pathToUuid('/djmlk8rqmyfbvw0cfe0lkllww/x')).toBeNull();
  });
});
