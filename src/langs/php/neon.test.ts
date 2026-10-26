import { describe, expect, it } from 'vitest';
import { toNeon } from './neon.js';

describe('toNeon', () => {
  it('writes nested mappings and lists in block style, every string quoted', () => {
    const text = toNeon({
      includes: ['vendor/a.neon', 'phpstan.project.neon'],
      parameters: {
        level: 'max',
        checkUninitializedProperties: true,
        cognitive_complexity: { function: 15 },
        'paths!': ['/abs/src'],
        ignoreErrors: [],
        empty: {},
        tmpDir: null,
      },
    });
    expect(text).toBe(
      [
        'includes:',
        '    - "vendor/a.neon"',
        '    - "phpstan.project.neon"',
        'parameters:',
        '    level: "max"',
        '    checkUninitializedProperties: true',
        '    cognitive_complexity:',
        '        function: 15',
        '    paths!:',
        '        - "/abs/src"',
        '    ignoreErrors: []',
        '    empty: {}',
        '    tmpDir: null',
        '',
      ].join('\n'),
    );
  });

  it('quotes keys NEON would misread and escapes strings the JSON way', () => {
    expect(toNeon({ 'a key': 'say "hi"\\', list: [{ message: '#x#' }] })).toBe(
      ['"a key": "say \\"hi\\"\\\\"', 'list:', '    -', '        message: "#x#"', ''].join('\n'),
    );
  });
});
