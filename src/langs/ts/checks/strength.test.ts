import { describe, expect, it } from 'vitest';
import { representatives } from './strength.js';
import { weakerStryker } from '../configs/stryker.js';
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

describe('weakerStryker', () => {
  it('names every setting that never runs a mutant or counts one as killed', () => {
    const found = weakerStryker({
      testRunner: 'command',
      commandRunner: { command: 'true' },
      ignoreStatic: true,
      ignorers: ['console'],
      checkers: ['typescript'],
      mutator: { excludedMutations: ['StringLiteral'] },
      timeoutMS: 100,
      timeoutFactor: 1,
      dryRunOnly: true,
    });
    expect(found.map((w) => w.setting)).toEqual([
      'testRunner',
      'ignoreStatic',
      'ignorers',
      'checkers',
      'mutator.excludedMutations',
      'timeoutMS',
      'timeoutFactor',
      'dryRunOnly',
    ]);
  });

  it('passes what changes no mutant’s fate, or only makes one harder to kill', () => {
    expect(
      weakerStryker({
        testRunner: 'vitest',
        vitest: { configFile: 'vitest.mutation.ts' },
        concurrency: 2,
        ignoreStatic: false,
        ignorers: [],
        checkers: [],
        mutator: { plugins: ['decorators'], excludedMutations: [] },
        timeoutMS: 60_000,
        timeoutFactor: 3,
        dryRunOnly: false,
      }),
    ).toEqual([]);
  });
});
