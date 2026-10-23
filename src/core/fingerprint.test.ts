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

  it('use the key when one is given, and differ by rule', () => {
    const keyed = { rule: 'r', message: 'm', key: 'lodash@4.17.20 GHSA-1' };
    expect(identity(keyed, undefined)).toBe('lodash@4.17.20 GHSA-1');
    expect(fingerprint('a', 'x')).not.toBe(fingerprint('b', 'x'));
  });
});
