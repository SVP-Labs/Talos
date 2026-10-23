import { describe, expect, it } from 'vitest';
import { parseTsc, tscFinding } from './types.js';

/** Recorded from tsc 6.0.3 --noEmit --pretty false. */
const RECORDED = [
  "src/a.ts(6,44): error TS2304: Cannot find name 'undefinedThing'.",
  "src/t.ts(3,49): error TS2322: Type 'string | number' is not assignable to type 'string'.",
  "  Type 'number' is not assignable to type 'string'.",
  "error TS5058: The specified path does not exist: 'missing.json'.",
  '',
].join('\n');

describe('parseTsc', () => {
  it('reads located and global diagnostics, leaving continuation lines out', () => {
    expect(parseTsc(RECORDED)).toEqual([
      {
        file: 'src/a.ts',
        line: 6,
        column: 44,
        code: 'TS2304',
        message: "Cannot find name 'undefinedThing'.",
      },
      {
        file: 'src/t.ts',
        line: 3,
        column: 49,
        code: 'TS2322',
        message: "Type 'string | number' is not assignable to type 'string'.",
      },
      {
        line: 1,
        column: 1,
        code: 'TS5058',
        message: "The specified path does not exist: 'missing.json'.",
      },
    ]);
  });

  it('reads a clean run as nothing', () => {
    expect(parseTsc('')).toEqual([]);
  });
});

describe('tscFinding', () => {
  const [located, , global] = parseTsc(RECORDED);
  const toRepo = (file: string): string => `apps/web/${file}`;

  it('makes paths repository-relative', () => {
    expect(located && tscFinding(located, toRepo, 'apps/web/tsconfig.json')).toEqual({
      rule: 'tsc/TS2304',
      message: "Cannot find name 'undefinedThing'.",
      location: { file: 'apps/web/src/a.ts', line: 6, column: 44 },
    });
  });

  it('keys a diagnostic about no file by its tsconfig', () => {
    expect(global && tscFinding(global, toRepo, 'tsconfig.json')).toMatchObject({
      rule: 'tsc/TS5058',
      key: "tsconfig.json The specified path does not exist: 'missing.json'.",
    });
  });
});
