import { describe, expect, it } from 'vitest';
import { cruiseFindings, cruiseRoots, importLine, parseCruise, specifierOf } from './arch.js';
import { EngineError } from '../../../core/check.js';

const VITEST = 'node_modules/.pnpm/vitest@5.0.5/node_modules/vitest/dist/index.d.ts';

/** Recorded from dependency-cruiser 18.7.0 --output-type json, trimmed to what Talos reads. */
const RECORDED = {
  modules: [
    { source: 'src/d.ts', dependencies: [{ module: './e.js', resolved: 'src/e.ts' }] },
    {
      source: 'src/e.ts',
      dependencies: [
        { module: './d.js', resolved: 'src/d.ts' },
        { module: 'vitest', resolved: VITEST },
      ],
    },
  ],
  summary: {
    violations: [
      {
        type: 'cycle',
        from: 'src/d.ts',
        to: 'src/e.ts',
        unresolvedTo: './e.js',
        rule: { severity: 'error', name: 'no-circular' },
        cycle: [{ name: 'src/e.ts' }, { name: 'src/d.ts' }],
      },
      {
        type: 'dependency',
        from: 'src/e.ts',
        to: VITEST,
        unresolvedTo: 'vitest',
        rule: { severity: 'error', name: 'no-dev-deps-in-shipped-code' },
      },
    ],
    ruleSetUsed: { forbidden: [{ name: 'no-circular', severity: 'error' }] },
    optionsUsed: {},
  },
};

const SOURCES: Readonly<Record<string, readonly string[]>> = {
  'src/d.ts': ["import { e } from './e.js';", 'export const d = (): number => e() + 1;'],
  'src/e.ts': [
    "import { d } from './d.js';",
    "import { describe } from 'vitest';",
    'export const e = (): number => d() + (describe ? 1 : 0);',
  ],
};

describe('cruiseFindings', () => {
  it('reports each violation at the import that causes it', () => {
    const result = parseCruise(RECORDED);
    expect(cruiseFindings(result, 'web', (file) => SOURCES[file] ?? [])).toEqual([
      {
        rule: 'depcruise/no-circular',
        message: 'This import closes a cycle: src/d.ts -> src/e.ts -> src/d.ts.',
        location: { file: 'web/src/d.ts', line: 1 },
      },
      {
        rule: 'depcruise/no-dev-deps-in-shipped-code',
        message: 'Shipped code imports vitest, a devDependency.',
        location: { file: 'web/src/e.ts', line: 2 },
      },
    ]);
  });

  it('refuses output that is not dependency-cruiser’s JSON', () => {
    expect(() => parseCruise({ modules: [] })).toThrow(EngineError);
  });
});

describe('import lines', () => {
  it('finds the specifier a module imports another by', () => {
    const result = parseCruise(RECORDED);
    expect(specifierOf(result, 'src/e.ts', 'src/d.ts')).toBe('./d.js');
    expect(specifierOf(result, 'src/x.ts', 'src/d.ts')).toBeUndefined();
    expect(importLine(SOURCES['src/e.ts'] ?? [], './d.js')).toBe(1);
    expect(importLine(['const x = require("y");'], 'y')).toBe(1);
    expect(importLine(['', 'await import(`./z.js`)'], './z.js')).toBe(2);
    expect(importLine(['nothing here'], 'gone')).toBe(1);
  });
});

describe('cruiseRoots', () => {
  it('cruises each top-level entry that holds code', () => {
    expect(
      cruiseRoots(['src/a.ts', 'src/b/c.ts', 'docs/x.md', 'eslint.config.js', 'test/t.ts']),
    ).toEqual(['eslint.config.js', 'src', 'test']);
  });
});
