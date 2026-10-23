import { describe, expect, it } from 'vitest';
import { fingerprint, identity, normalise } from './fingerprint.js';

describe('fingerprints', () => {
  it('ignore indentation and spacing', () => {
    expect(normalise('  if (a)   {\n\treturn b; }')).toBe('if (a) { return b; }');
  });

  it('come from the code at the location, not the path or line', () => {
    const lines = ['x', '  const a = 1;', 'y'];
    const moved = ['const a = 1;'];
    const here = identity({ rule: 'r', message: 'm', location: { file: 'a.ts', line: 2 } }, lines);
    const there = identity({ rule: 'r', message: 'm', location: { file: 'b.ts', line: 1 } }, moved);
    expect(fingerprint('r', here)).toBe(fingerprint('r', there));
  });

  it('cover the whole span of a finding', () => {
    const lines = ['function f() {', '  return 1;', '}'];
    const span = { rule: 'r', message: 'm', location: { file: 'a.ts', line: 1, endLine: 3 } };
    expect(identity(span, lines)).toBe('function f() { return 1; }');
  });

  it('cover at most the first 200 lines of a span', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `line${index + 1}`);
    const long = { rule: 'r', message: 'm', location: { file: 'a.ts', line: 1, endLine: 300 } };
    expect(identity(long, lines)).toBe(lines.slice(0, 200).join(' '));
  });

  it('use the key when one is given, and differ by rule', () => {
    const keyed = { rule: 'r', message: 'm', key: 'lodash@4.17.20 GHSA-1' };
    expect(identity(keyed, undefined)).toBe('lodash@4.17.20 GHSA-1');
    expect(fingerprint('a', 'x')).not.toBe(fingerprint('b', 'x'));
  });

  it('use the message when there is no location or no code to read', () => {
    const located = { rule: 'r', message: 'm', location: { file: 'a.ts', line: 1 } };
    expect(identity({ rule: 'r', message: 'm' }, ['code'])).toBe('m');
    expect(identity(located, undefined)).toBe('m');
  });

  it('name the file when the lines it points at are blank', () => {
    const blank = { rule: 'r', message: 'm', location: { file: 'a.ts', line: 2 } };
    expect(identity(blank, ['code', '   ', 'more'])).toBe('a.ts:empty');
  });

  it('are the first 32 hex digits of the SHA-256 of the rule and the code, kept apart', () => {
    expect(fingerprint('eslint/complexity', 'if (a) { return b; }')).toBe(
      'af2764be26fafcca90671aecf5862913',
    );
    expect(fingerprint('ab', 'c')).not.toBe(fingerprint('a', 'bc'));
  });
});
