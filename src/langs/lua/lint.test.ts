import { describe, expect, it } from 'vitest';
import { deadCodeFindings } from './deadcode.js';
import { functionEnds, lintFindings } from './lint.js';
import type { LuacheckFile } from './luacheck.js';
import type { Bound } from './run.js';
import type { FileShape } from './shape.js';

const ctx = {
  root: '/repo',
  component: { lang: 'lua', root: '.', os: ['linux'] },
  os: 'linux',
} as unknown as Bound;

const files: LuacheckFile[] = [
  {
    file: 'src/a.lua',
    events: [
      { code: '211', line: 2, column: 7, endColumn: 7, message: "unused variable 'x'" },
      {
        code: '561',
        line: 3,
        column: 1,
        endColumn: 10,
        message: "cyclomatic complexity of function 'a.f' is too high (13 > 12)",
      },
      {
        code: '113',
        line: 9,
        column: 5,
        endColumn: 9,
        message: "accessing undefined variable 'z'",
      },
    ],
  },
];

const shapes: FileShape[] = [
  {
    file: 'src/a.lua',
    lines: 20,
    code: [],
    depth: 0,
    deepLine: 1,
    deepEndLine: 1,
    functions: [
      {
        name: 'a.f',
        line: 3,
        endLine: 8,
        params: 0,
        codeLines: 6,
        cognitive: 0,
        depth: 0,
        deepLine: 3,
        deepEndLine: 8,
      },
    ],
  },
];

describe('lint and dead code', () => {
  it('splits luacheck warnings so each appears once', () => {
    const lint = lintFindings(ctx, files, functionEnds(shapes)).map((f) => f.rule);
    const dead = deadCodeFindings(ctx, files).map((f) => f.rule);
    expect(lint).toEqual(['luacheck/W561', 'luacheck/W113']);
    expect(dead).toEqual(['luacheck/W211']);
  });

  it('widens a complexity warning to the whole function', () => {
    const [complexity, global] = lintFindings(ctx, files, functionEnds(shapes));
    expect(complexity?.location).toEqual({ file: 'src/a.lua', line: 3, endLine: 8, column: 1 });
    expect(global?.location).toEqual({ file: 'src/a.lua', line: 9, endLine: 9, column: 5 });
  });

  it('keeps a complexity warning on its line when no function starts there', () => {
    const [complexity] = lintFindings(ctx, files, new Map());
    expect(complexity?.location?.endLine).toBe(3);
  });
});
