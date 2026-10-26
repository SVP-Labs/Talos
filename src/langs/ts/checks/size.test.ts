import { describe, expect, it } from 'vitest';
import { formatBytes, parseSizeLimit, sizeFindings, sizeOwner } from './size.js';
import { parseConfig } from '../../../config/load.js';
import { EngineError } from '../../../core/check.js';
import { repoFacts } from '../../../repo/facts.js';

describe('parseSizeLimit', () => {
  it('keeps the entries over their budget', () => {
    // Recorded from size-limit 14.1.0 --json.
    const recorded = [
      { name: 'App: JavaScript', passed: false, size: 3075, sizeLimit: 1000 },
      { name: 'App: small', passed: true, size: 3075, sizeLimit: 100_000 },
    ];
    expect(parseSizeLimit(recorded)).toEqual([
      { name: 'App: JavaScript', size: 3075, limit: 1000 },
    ]);
  });

  it("turns size-limit's own error into an engine error", () => {
    const recorded = {
      error: "Error: ENOENT: no such file or directory, open 'missing.json'\n    at open",
    };
    expect(() => parseSizeLimit(recorded)).toThrow(EngineError);
    expect(() => parseSizeLimit(recorded)).toThrow(/ENOENT/);
  });
});

describe('sizeFindings', () => {
  it('points at the entry in the budget file', () => {
    const lines = [
      '[',
      '  { "name": "App: JavaScript", "path": "dist/app.js", "limit": "1 kB" }',
      ']',
    ];
    expect(
      sizeFindings(
        [{ name: 'App: JavaScript', size: 3075, limit: 1000 }],
        '.size-limit.json',
        lines,
      ),
    ).toEqual([
      {
        rule: 'size-limit/exceeded',
        message: 'App: JavaScript is 3.1 kB, over its 1.0 kB budget.',
        key: 'size-limit App: JavaScript',
        location: { file: '.size-limit.json', line: 2 },
      },
    ]);
    expect(formatBytes(512)).toBe('512 B');
  });
});

describe('sizeOwner', () => {
  const config = parseConfig(
    'name: T\nprefix: T\nsize: apps/web/.size-limit.json\ncomponents:\n  - { lang: ts }\n  - { lang: ts, root: apps/web }\n',
  );
  const base = {
    facts: repoFacts([], []),
    config,
    side: 'alone' as const,
    tiers: ['head' as const],
  };

  it('gives the budget to the deepest TypeScript component holding it', () => {
    const [root, web] = config.components;
    expect(web && sizeOwner({ ...base, component: web })).toBe(true);
    expect(root && sizeOwner({ ...base, component: root })).toBe(false);
  });
});
