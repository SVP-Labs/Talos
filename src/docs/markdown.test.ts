import { describe, expect, it } from 'vitest';
import {
  anchors,
  headings,
  headingText,
  maskCode,
  maskCodeSpans,
  maskFences,
  position,
  slugger,
} from './markdown.js';

const spaces = (count: number): string => ' '.repeat(count);

describe('masking', () => {
  it('blanks fenced code, fences included, and keeps every line', () => {
    const text = 'a\n```ts\nconst C8 = 1;\n```\nb\n  ~~~~\n  x\n  ~~~~\nc';
    const masked = maskFences(text);
    expect(masked.split('\n')).toHaveLength(text.split('\n').length);
    expect(masked).not.toContain('C8');
    expect(masked).not.toContain('x');
    expect(masked.split('\n').filter((line) => line.trim() !== '')).toEqual(['a', 'b', 'c']);
  });

  it('needs a closing fence as long as the opening one', () => {
    expect(maskFences('````\n```\nhidden\n````\nshown')).toBe(
      [spaces(4), spaces(3), spaces(6), spaces(4), 'shown'].join('\n'),
    );
  });

  it('blanks code spans of any backtick count, across a wrapped line', () => {
    expect(maskCodeSpans('see `C8` and ``a ` b`` here')).toBe(
      `see ${spaces(4)} and ${spaces(9)} here`,
    );
    expect(maskCodeSpans('a `talos\ncheck` b')).toBe(`a ${spaces(6)}\n${spaces(6)} b`);
    expect(maskCodeSpans('an unclosed ` stays')).toBe('an unclosed ` stays');
    expect(maskCodeSpans('`a\n\nb`')).toBe('`a\n\nb`');
  });

  it('blanks HTML comments too', () => {
    expect(maskCode('x <!-- C8 --> y')).toBe(`x ${spaces(11)} y`);
  });
});

describe('headings', () => {
  it('reads ATX and underlined headings outside code', () => {
    const text =
      '# Title #\n\nSome\n===\n\n```\n# not one\n```\n\n## `talos.yml` keys\nPara\n---\n';
    expect(headings(text)).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 1, text: 'Some', line: 3 },
      { level: 2, text: '`talos.yml` keys', line: 10 },
      { level: 2, text: 'Para', line: 11 },
    ]);
  });

  it('does not read a list item or a rule after a blank line as an underlined heading', () => {
    expect(headings('- item\n---\n\n---\n')).toEqual([]);
  });

  it('renders inline Markdown down to its text', () => {
    expect(headingText('**Bold** and [a link](x.md) with `code` and max_claims')).toBe(
      'Bold and [a link with code and max_claims',
    );
  });
});

describe('slugger', () => {
  it("makes GitHub's anchors", () => {
    const slug = slugger();
    expect(slug('3. The claim')).toBe('3-the-claim');
    expect(slug('C8 · The check model')).toBe('c8--the-check-model');
    expect(slug('The `a.b` file')).toBe('the-ab-file');
    expect(slug("The owner's instructions")).toBe('the-owners-instructions');
    expect(slug('Café and_snake')).toBe('café-and_snake');
  });

  it('numbers repeated anchors', () => {
    const slug = slugger();
    expect([slug('Usage'), slug('Usage'), slug('Usage-1'), slug('Usage')]).toEqual([
      'usage',
      'usage-1',
      'usage-1-1',
      'usage-2',
    ]);
  });

  it('collects heading anchors and explicit ids', () => {
    const found = anchors('# One\n\n## Two\n\n<a id="custom"></a>\n<span name=\'other\'>');
    expect([...found].sort((a, b) => a.localeCompare(b))).toEqual([
      'custom',
      'one',
      'other',
      'two',
    ]);
  });
});

describe('position', () => {
  it('turns an offset into a line and column', () => {
    expect(position('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
    expect(position('ab', 0)).toEqual({ line: 1, column: 1 });
  });
});
