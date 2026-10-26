import { describe, expect, it } from 'vitest';
import { toolsLockDeclarations } from './tools-lock.js';

describe('tools.lock lines', () => {
  it('points at the runtime under runtimes, quoted or bare, past a tool of the same name', () => {
    const lock = [
      'tools:',
      '  python: { version: 1.0.0 }',
      'runtimes:',
      "  'python' : 3.13.1",
      '  "lua": 5.4.7',
      '',
    ].join('\n');
    const lines = toolsLockDeclarations('tools.lock', lock).map((d) => [d.runtime, d.line]);
    expect(lines).toEqual([
      ['python', 4],
      ['lua', 5],
    ]);
  });

  it('points at the first line when the key is written in a way it does not read', () => {
    const lock = 'runtimes: { python: 3.13.1 }\n';
    expect(toolsLockDeclarations('tools.lock', lock).map((d) => d.line)).toEqual([1]);
  });
});
