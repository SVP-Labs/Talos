import { describe, expect, it } from 'vitest';
import { parseKnip } from './deadcode.js';
import { EngineError } from '../../../core/check.js';

/** Recorded from knip 6.42.1 --reporter json, plus a dependency and a duplicate. */
const RECORDED = {
  issues: [
    {
      file: 'src/c.ts',
      binaries: [],
      dependencies: [],
      devDependencies: [],
      duplicates: [],
      exports: [],
      files: [{ name: 'src/c.ts' }],
      types: [],
      unlisted: [],
      unresolved: [],
    },
    {
      file: 'src/a.ts',
      exports: [{ name: 'g', line: 6, col: 14, pos: 107 }],
      duplicates: [[{ name: 'f' }, { name: 'default', line: 9, col: 1 }]],
      unlisted: [{ name: 'lodash', line: 2, col: 20 }],
    },
    {
      file: 'package.json',
      devDependencies: [{ name: 'left-pad', line: 12, col: 6 }],
    },
  ],
};

describe('parseKnip', () => {
  it('turns each issue into a finding by kind', () => {
    const findings = parseKnip(RECORDED, (file) => `web/${file}`);
    expect(findings).toEqual([
      {
        rule: 'knip/files',
        message: 'web/src/c.ts is not reached from any entry point.',
        location: { file: 'web/src/c.ts', line: 1 },
      },
      {
        rule: 'knip/exports',
        message: 'g is exported but never imported.',
        location: { file: 'web/src/a.ts', line: 6, column: 14 },
      },
      {
        rule: 'knip/duplicates',
        message: 'f, default export the same thing; keep one.',
        location: { file: 'web/src/a.ts', line: 1 },
      },
      {
        rule: 'knip/unlisted',
        message: 'lodash is imported but not listed in package.json.',
        location: { file: 'web/src/a.ts', line: 2, column: 20 },
      },
      {
        rule: 'knip/devDependencies',
        message: 'left-pad is in devDependencies, but nothing uses it.',
        location: { file: 'web/package.json', line: 12, column: 6 },
        key: 'devDependencies left-pad',
      },
    ]);
  });

  it('refuses output that is not knip’s JSON', () => {
    expect(() => parseKnip([], (file) => file)).toThrow(EngineError);
  });
});
