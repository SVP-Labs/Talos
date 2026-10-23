import { describe, expect, it } from 'vitest';
import { markdownLinks, resolveLink } from './links.js';

describe('markdownLinks', () => {
  it('finds inline links, images, nested ones and definitions, with where they are', () => {
    const text = [
      'See [the brief](docs/a.md#c8--model "title") and ![logo](img/logo.png).',
      '[![badge](b.svg)](https://example.com) [spaced](<docs/a b.md>)',
      '',
      '[ref]: ../x.md',
      '[^1]: A footnote, not a link.',
      '<a href="docs/b.md">b</a>',
    ].join('\n');
    expect(markdownLinks(text)).toEqual([
      { target: 'docs/a.md#c8--model', line: 1, column: 17 },
      { target: 'img/logo.png', line: 1, column: 58 },
      { target: 'b.svg', line: 2, column: 11 },
      { target: 'https://example.com', line: 2, column: 19 },
      { target: 'docs/a b.md', line: 2, column: 49 },
      { target: '../x.md', line: 4, column: 8 },
      { target: 'docs/b.md', line: 6, column: 1 },
    ]);
  });

  it('ignores links in code and keeps balanced parentheses', () => {
    const text = '`[no](a.md)`\n```\n[no](b.md)\n```\n[yes](c_(1).md) [and](d.md)';
    expect(markdownLinks(text).map((link) => link.target)).toEqual(['c_(1).md', 'd.md']);
  });
});

describe('resolveLink', () => {
  it('leaves off-site links alone', () => {
    expect(resolveLink('a.md', 'https://x.dev')).toEqual({ kind: 'external' });
    expect(resolveLink('a.md', 'mailto:me@example.com')).toEqual({ kind: 'external' });
    expect(resolveLink('a.md', '//cdn.example.com/x')).toEqual({ kind: 'external' });
  });

  it('resolves relative, root and anchor-only links', () => {
    expect(resolveLink('docs/a.md', '../README.md#usage')).toEqual({
      kind: 'local',
      path: 'README.md',
      anchor: 'usage',
    });
    expect(resolveLink('docs/a.md', '/src/x%20y.ts?plain=1')).toEqual({
      kind: 'local',
      path: 'src/x y.ts',
    });
    expect(resolveLink('docs/a.md', '#c8--the-check-model')).toEqual({
      kind: 'local',
      path: '',
      anchor: 'c8--the-check-model',
    });
    expect(resolveLink('docs/a.md', './')).toEqual({ kind: 'local', path: 'docs' });
  });

  it("knows a link above the root, such as GitHub's ../../issues", () => {
    expect(resolveLink('README.md', '../../issues')).toEqual({ kind: 'outside' });
  });
});
