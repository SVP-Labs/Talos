import { describe, expect, it } from 'vitest';
import { cloneFindings } from './jscpd-report.js';
import { EngineError } from '../../core/check.js';

/** jscpd 5.4.2's JSON report for a Python file repeating itself and two TypeScript files. */
const RECORDED = JSON.stringify({
  duplicates: [
    {
      firstFile: {
        end: 8,
        endLoc: { column: 36, line: 8, position: 230 },
        name: 'lib/c.py',
        start: 1,
        startLoc: { column: 9, line: 1, position: 9 },
      },
      format: 'python',
      isNew: false,
      kind: 'exact',
      lines: 8,
      secondFile: {
        end: 18,
        endLoc: { column: 36, line: 18, position: 469 },
        name: 'lib/c.py',
        start: 11,
        startLoc: { column: 15, line: 11, position: 248 },
      },
      tokens: 54,
    },
    {
      firstFile: { end: 14, name: '/repo/src/b.ts', start: 4 },
      format: 'typescript',
      kind: 'exact',
      lines: 11,
      secondFile: { end: 11, name: '/repo/src/a.ts', start: 1 },
      tokens: 79,
    },
  ],
  statistics: { total: { clones: 2, duplicatedLines: 19, percentage: 44.19 } },
});

describe('cloneFindings', () => {
  it('reports each clone on its later copy, naming the other', () => {
    expect(cloneFindings(RECORDED, '/repo')).toEqual([
      {
        rule: 'jscpd/clone',
        message:
          'Lines 11-18 repeat lines 1-8 of this file (54 tokens): keep one copy and share it.',
        location: { file: 'lib/c.py', line: 11, endLine: 18 },
      },
      {
        rule: 'jscpd/clone',
        message: 'Lines 4-14 repeat src/a.ts lines 1-11 (79 tokens): keep one copy and share it.',
        location: { file: 'src/b.ts', line: 4, endLine: 14 },
      },
    ]);
  });

  it('reads Windows paths and a report with no clones', () => {
    const windows = JSON.stringify({
      duplicates: [
        {
          tokens: 60,
          firstFile: { name: String.raw`src\x.ts`, start: 0, end: 6 },
          secondFile: { name: './src/y.ts', start: 2, end: 8 },
        },
      ],
    });
    expect(cloneFindings(windows, '/repo')[0]?.location).toEqual({
      file: 'src/y.ts',
      line: 2,
      endLine: 8,
    });
    expect(cloneFindings('{"duplicates": [], "statistics": {}}', '/repo')).toEqual([]);
  });

  it('makes a Windows extended-length path relative to the root', () => {
    const extended = JSON.stringify({
      duplicates: [
        {
          tokens: 60,
          firstFile: { name: '//?/C:/repo/src/x.ts', start: 0, end: 6 },
          secondFile: { name: String.raw`\\?\C:\repo\src\y.ts`, start: 2, end: 8 },
        },
      ],
    });
    expect(cloneFindings(extended, String.raw`\\?\C:\repo`)).toEqual([
      {
        rule: 'jscpd/clone',
        message: 'Lines 2-8 repeat src/x.ts lines 1-6 (60 tokens): keep one copy and share it.',
        location: { file: 'src/y.ts', line: 2, endLine: 8 },
      },
    ]);
  });

  it('relativizes with path.win32 when only the root is drive-rooted', () => {
    const mixed = JSON.stringify({
      duplicates: [
        {
          tokens: 25,
          firstFile: { name: '/repo/src/a.ts', start: 1, end: 2 },
          secondFile: { name: 'C:/repo/src/b.ts', start: 3, end: 4 },
        },
      ],
    });
    const [finding] = cloneFindings(mixed, 'C:\\repo');
    expect(finding?.location).toEqual({ file: 'src/b.ts', line: 3, endLine: 4 });
    if (process.platform === 'win32') {
      expect(finding?.message).toBe(
        'Lines 3-4 repeat src/a.ts lines 1-2 (25 tokens): keep one copy and share it.',
      );
    } else {
      // path.win32 only resolves a driveless absolute name (no "C:") against the real OS
      // drive on an actual Windows host; elsewhere it finds no shared root with the
      // drive-rooted base and leaves the name as given. That still proves path.win32 (not
      // path.posix) ran: path.posix would recognize '/repo/src/a.ts' as absolute on its own
      // and resolve it against the current working directory instead, a different result.
      expect(finding?.message).toBe(
        'Lines 3-4 repeat /repo/src/a.ts lines 1-2 (25 tokens): keep one copy and share it.',
      );
    }
  });

  it('relativizes a UNC root with the host OS, not always path.posix', () => {
    const unc = JSON.stringify({
      duplicates: [
        {
          tokens: 20,
          firstFile: { name: String.raw`\\server\share\repo\src\x.ts`, start: 1, end: 2 },
          secondFile: { name: String.raw`\\server\share\repo\src\y.ts`, start: 3, end: 4 },
        },
      ],
    });
    const file = cloneFindings(unc, String.raw`\\server\share\repo`)[0]?.location?.file;
    if (process.platform === 'win32') {
      expect(file).toBe('src/y.ts');
    } else {
      // No drive letter in a UNC path, so path.posix (this host's default away from Windows)
      // cannot recognize it as absolute either, same as before path.win32 was ever chosen here.
      expect(file).toBe('//server/share/repo/src/y.ts');
    }
  });

  it('is an engine error for a report it cannot read', () => {
    expect(() => cloneFindings('not json', '/repo')).toThrow(EngineError);
    expect(() => cloneFindings('{"clones": []}', '/repo')).toThrow(/unknown shape/);
  });
});
