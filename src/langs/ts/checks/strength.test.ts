import { describe, expect, it } from 'vitest';
import { representatives } from './strength.js';
import { shadowing } from '../shadows.js';

describe('representatives', () => {
  it('takes one file of each kind ESLint configures differently', () => {
    const files = [
      'eslint.config.js',
      'src/a.ts',
      'src/b.ts',
      'src/view.tsx',
      'src/a.test.ts',
      'test/helpers.ts',
      'scripts/x.mjs',
    ];
    expect(representatives(files)).toEqual([
      'src/a.ts',
      'src/view.tsx',
      'src/a.test.ts',
      'scripts/x.mjs',
      'eslint.config.js',
    ]);
  });

  it('skips kinds the component lacks', () => {
    expect(representatives(['src/a.mts'])).toEqual(['src/a.mts']);
    expect(representatives([])).toEqual([]);
  });
});

describe('shadowing', () => {
  it('finds config files a tool would read instead of the base', () => {
    expect(
      shadowing([
        '.prettierrc.json',
        'knip.json',
        'src/knip.json',
        '.dependency-cruiser.js',
        'prettier.config.js',
      ]),
    ).toEqual([
      { file: '.prettierrc.json', base: 'prettier.config.js' },
      { file: 'knip.json', base: 'knip.config.js' },
      { file: '.dependency-cruiser.js', base: '.dependency-cruiser.cjs' },
    ]);
  });
});
