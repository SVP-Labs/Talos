import { describe, expect, it } from 'vitest';
import { formatTargets, parsePrettier } from './format.js';

describe('parsePrettier', () => {
  it('reads unformatted files and parse errors from prettier --list-different', () => {
    // Recorded from prettier 3.9.10 on src/a.ts src/c.ts src/bad.ts src/b.ts.
    const stdout = 'src/c.ts\n';
    const stderr = [
      '[error] src/bad.ts: SyntaxError: Expression expected. (1:12)',
      '[error] > 1 | const x = (;',
      '[error]     |            ^',
      '[error]   2 |',
      '',
    ].join('\n');
    expect(parsePrettier(stdout, stderr)).toEqual({
      unformatted: ['src/c.ts'],
      errors: [{ file: 'src/bad.ts', line: 1, column: 12, message: 'Expression expected.' }],
    });
  });

  it('reads a clean run as nothing', () => {
    expect(parsePrettier('', '')).toEqual({ unformatted: [], errors: [] });
  });
});

describe('formatTargets', () => {
  it("keeps the files Prettier formats, without lockfiles or Talos's rendered files", () => {
    const files = [
      'apps/web/src/a.ts',
      'apps/web/README.md',
      'apps/web/pnpm-lock.yaml',
      'apps/web/eslint.config.js',
      'apps/web/eslint.project.js',
      'apps/web/src/logo.png',
      'apps/web/notes.txt',
    ];
    expect(formatTargets(files, 'apps/web')).toEqual([
      'src/a.ts',
      'README.md',
      'eslint.project.js',
    ]);
  });
});
