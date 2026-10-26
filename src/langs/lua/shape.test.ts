import { describe, expect, it } from 'vitest';
import { type FileShape, type FunctionShape, LIMITS, parseShapes, shapeFindings } from './shape.js';

// Recorded from Talos's shape script with luacheck 1.2.0: one file, and one it can't parse.
const RECORDED =
  '{"files":[{"code":[1,2,3,4,5,6,7],"deepEndLine":1,"deepLine":1,"depth":0,"error":"","file":"src/a.lua","functions":[{"codeLines":3,"cognitive":0,"deepEndLine":5,"deepLine":3,"depth":0,"endLine":5,"line":3,"name":"a.f","params":2}],"lines":8},{"error":"syntax","file":"src/bad.lua"}]}\n';

function fn(overrides: Partial<FunctionShape>): FunctionShape {
  return {
    name: 'm.f',
    line: 10,
    endLine: 20,
    params: 1,
    codeLines: 5,
    cognitive: 0,
    depth: 0,
    deepLine: 10,
    deepEndLine: 20,
    ...overrides,
  };
}

function file(overrides: Partial<FileShape>): FileShape {
  return {
    file: 'src/m.lua',
    lines: 30,
    code: [1, 2, 3],
    depth: 0,
    deepLine: 1,
    deepEndLine: 1,
    functions: [],
    ...overrides,
  };
}

describe('parseShapes', () => {
  it('reads measured files and leaves out one that does not parse', () => {
    const shapes = parseShapes(RECORDED);
    expect(shapes.map((s) => s.file)).toEqual(['src/a.lua']);
    expect(shapes[0]?.functions[0]).toMatchObject({ name: 'a.f', line: 3, endLine: 5, params: 2 });
  });

  it('fails on a file it could not read, and on output it cannot read', () => {
    expect(() => parseShapes('{"files":[{"error":"unreadable","file":"x.lua"}]}')).toThrow(
      /could not read x.lua/,
    );
    expect(() => parseShapes('{"files":[{"file":"x.lua"}]}')).toThrow(/unknown shape/);
  });
});

describe('shapeFindings', () => {
  it('finds nothing in code within every limit', () => {
    expect(shapeFindings('pkg/m.lua', file({ functions: [fn({})] }), false)).toEqual([]);
  });

  it('spans a long file from its first line over the limit to its end', () => {
    const code = Array.from({ length: LIMITS.fileLines + 2 }, (_, i) => i * 2 + 1);
    const [finding] = shapeFindings('pkg/m.lua', file({ code, lines: 900 }), false);
    expect(finding).toEqual({
      rule: 'talos/max-lines',
      message: 'This file has 402 lines of code; the most allowed is 400.',
      location: { file: 'pkg/m.lua', line: 801, endLine: 900 },
    });
  });

  it('reports each limit a function passes over its whole span', () => {
    const big = fn({ params: 5, codeLines: 61, cognitive: 16 });
    const rules = shapeFindings('pkg/m.lua', file({ functions: [big] }), false).map((f) => [
      f.rule,
      f.location?.line,
      f.location?.endLine,
    ]);
    expect(rules).toEqual([
      ['talos/max-lines-per-function', 10, 20],
      ['talos/max-params', 10, 20],
      ['talos/cognitive-complexity', 10, 20],
    ]);
  });

  it('exempts tests from the size limits only', () => {
    const code = Array.from({ length: LIMITS.fileLines + 1 }, (_, i) => i + 1);
    const big = fn({ params: 5, codeLines: 61 });
    const rules = shapeFindings('spec/m_spec.lua', file({ code, functions: [big] }), true).map(
      (f) => f.rule,
    );
    expect(rules).toEqual(['talos/max-params']);
  });

  it('reports nesting at the deepest statement, in the main chunk too', () => {
    const nested = fn({ name: '', depth: 4, deepLine: 14, deepEndLine: 16 });
    const found = shapeFindings(
      'm.lua',
      file({ depth: 5, deepLine: 2, deepEndLine: 9, functions: [nested] }),
      false,
    );
    expect(found).toEqual([
      {
        rule: 'talos/max-depth',
        message: 'Blocks in the main chunk are nested 5 deep; the most allowed is 3.',
        location: { file: 'm.lua', line: 2, endLine: 9 },
      },
      {
        rule: 'talos/max-depth',
        message: 'Blocks in an anonymous function are nested 4 deep; the most allowed is 3.',
        location: { file: 'm.lua', line: 14, endLine: 16 },
      },
    ]);
  });
});
