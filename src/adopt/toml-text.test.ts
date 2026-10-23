import { describe, expect, it } from 'vitest';
import {
  bodyEnd,
  headerOf,
  insertLines,
  joinToml,
  keyLine,
  replaceLine,
  sameToml,
  spaced,
  splitToml,
  within,
} from './toml-text.js';

const TEXT = [
  '# The file',
  'title = "x"',
  '',
  '# About a',
  '[a]',
  'list = [',
  '  "[not.a.header]",',
  '  # [nor.this]',
  ']',
  'text = """',
  '[inside.a.string]',
  '"""',
  '',
  '[[a.items]]  # one item',
  'name = "y"',
  '',
].join('\n');

describe('splitToml', () => {
  it('splits at real headers only, each with the comments directly above it', () => {
    const sections = splitToml(TEXT);
    expect(sections.map((s) => [s.name, s.array])).toEqual([
      [undefined, false],
      ['a', false],
      ['a.items', true],
    ]);
    expect(sections[0]?.lines).toEqual(['# The file', 'title = "x"', '']);
    expect(sections[1]?.lines.slice(0, 2)).toEqual(['# About a', '[a]']);
    expect(joinToml(sections)).toBe(TEXT);
  });

  it('reads headers with spaces and comments, and nothing else', () => {
    expect(headerOf('[ tool . ruff ]  # x')).toEqual({ name: 'tool.ruff', array: false });
    expect(headerOf('[[rules]]')).toEqual({ name: 'rules', array: true });
    expect(headerOf('[a] b = 1')).toBeUndefined();
    expect(headerOf('[]')).toBeUndefined();
    expect(headerOf('[unclosed')).toBeUndefined();
    expect(headerOf('key = 1')).toBeUndefined();
  });

  it('keeps the line ending and drops trailing blank lines when joined', () => {
    expect(joinToml(splitToml('a = 1\r\n\r\n'), '\r\n')).toBe('a = 1\r\n');
    expect(joinToml(splitToml(''))).toBe('');
  });
});

describe('section edits', () => {
  const [, section] = splitToml('[a]\nx = 1\n# x = 2\ny = """\nx = 3\n"""\n\n');

  it('finds a key at the top of the body, not in comments or strings', () => {
    expect(section).toBeDefined();
    if (section === undefined) return;
    expect(keyLine(section, 'x')).toBe(1);
    expect(keyLine(section, 'y')).toBe(3);
    expect(keyLine(section, 'z')).toBe(-1);
    expect(bodyEnd(section)).toBe(6);
    expect(insertLines(section, 2, ['z = 4']).lines[2]).toBe('z = 4');
    expect(replaceLine(section, 1, 'x = 9').lines[1]).toBe('x = 9');
  });

  it('spaces sections apart and tells sub-tables', () => {
    const joined = joinToml(spaced(splitToml('[a]\nx = 1\n[b]\ny = 2\n')));
    expect(joined).toBe('[a]\nx = 1\n\n[b]\ny = 2\n');
    expect(within('tool.ruff.lint', 'tool.ruff')).toBe(true);
    expect(within('tool.ruffles', 'tool.ruff')).toBe(false);
    expect(within(undefined, 'tool.ruff')).toBe(false);
  });

  it('compares parsed documents as plain data', () => {
    expect(sameToml({ a: new Date('2027-01-08') }, { a: new Date('2027-01-08') })).toBe(true);
    expect(sameToml({ a: [1] }, { a: [2] })).toBe(false);
  });
});
