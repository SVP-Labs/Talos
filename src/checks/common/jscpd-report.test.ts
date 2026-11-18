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

  it('relativizes a UNC root the same way on every host', () => {
    const unc = JSON.stringify({
      duplicates: [
        {
          tokens: 20,
          firstFile: { name: String.raw`\\server\share\repo\src\x.ts`, start: 1, end: 2 },
          secondFile: { name: String.raw`\\server\share\repo\src\y.ts`, start: 3, end: 4 },
        },
      ],
    });
    expect(cloneFindings(unc, String.raw`\\server\share\repo`)).toEqual([
      {
        rule: 'jscpd/clone',
        message: 'Lines 3-4 repeat src/x.ts lines 1-2 (20 tokens): keep one copy and share it.',
        location: { file: 'src/y.ts', line: 3, endLine: 4 },
      },
    ]);
  });

  it('makes an extended-length UNC path relative to its plain UNC root', () => {
    const extendedUnc = JSON.stringify({
      duplicates: [
        {
          tokens: 20,
          firstFile: { name: '//?/UNC/server/share/repo/src/x.ts', start: 1, end: 2 },
          secondFile: { name: String.raw`\\?\UNC\server\share\repo\src\y.ts`, start: 3, end: 4 },
        },
      ],
    });
    expect(cloneFindings(extendedUnc, String.raw`\\server\share\repo`)).toEqual([
      {
        rule: 'jscpd/clone',
        message: 'Lines 3-4 repeat src/x.ts lines 1-2 (20 tokens): keep one copy and share it.',
        location: { file: 'src/y.ts', line: 3, endLine: 4 },
      },
    ]);
  });

  it('leaves a name that is not under the root alone', () => {
    const outside = JSON.stringify({
      duplicates: [
        {
          tokens: 15,
          firstFile: { name: '/elsewhere/src/a.ts', start: 1, end: 2 },
          secondFile: { name: '/repo/src/b.ts', start: 3, end: 4 },
        },
      ],
    });
    expect(cloneFindings(outside, '/repo')).toEqual([
      {
        rule: 'jscpd/clone',
        message:
          'Lines 3-4 repeat /elsewhere/src/a.ts lines 1-2 (15 tokens): keep one copy and share it.',
        location: { file: 'src/b.ts', line: 3, endLine: 4 },
      },
    ]);
  });

  it('does not strip a sibling directory whose name merely starts with the root', () => {
    const sibling = JSON.stringify({
      duplicates: [
        {
          tokens: 15,
          firstFile: { name: 'C:/repository/src/x.ts', start: 1, end: 2 },
          secondFile: { name: 'C:/repo/src/y.ts', start: 3, end: 4 },
        },
      ],
    });
    expect(cloneFindings(sibling, 'C:/repo')).toEqual([
      {
        rule: 'jscpd/clone',
        message:
          'Lines 3-4 repeat C:/repository/src/x.ts lines 1-2 (15 tokens): keep one copy and ' +
          'share it.',
        location: { file: 'src/y.ts', line: 3, endLine: 4 },
      },
    ]);
  });

  it('relativizes the same way whether or not the root has a trailing slash', () => {
    const report = JSON.stringify({
      duplicates: [
        {
          tokens: 10,
          firstFile: { name: 'C:/repo/src/x.ts', start: 1, end: 2 },
          secondFile: { name: 'C:/repo/src/y.ts', start: 3, end: 4 },
        },
      ],
    });
    expect(cloneFindings(report, 'C:/repo/')).toEqual(cloneFindings(report, 'C:/repo'));
    expect(cloneFindings(report, 'C:/repo')[0]?.location).toEqual({
      file: 'src/y.ts',
      line: 3,
      endLine: 4,
    });
  });

  it("compares a drive letter's case only, leaving the rest of the path as given", () => {
    const lowerDrive = JSON.stringify({
      duplicates: [
        {
          tokens: 10,
          firstFile: { name: 'c:/repo/src/x.ts', start: 1, end: 2 },
          secondFile: { name: 'C:/repo/src/y.ts', start: 3, end: 4 },
        },
      ],
    });
    expect(cloneFindings(lowerDrive, 'C:/repo')).toEqual([
      {
        rule: 'jscpd/clone',
        message: 'Lines 3-4 repeat src/x.ts lines 1-2 (10 tokens): keep one copy and share it.',
        location: { file: 'src/y.ts', line: 3, endLine: 4 },
      },
    ]);

    const differentCaseFolder = JSON.stringify({
      duplicates: [
        {
          tokens: 10,
          firstFile: { name: 'C:/Repo/src/x.ts', start: 1, end: 2 },
          secondFile: { name: 'C:/repo/src/y.ts', start: 3, end: 4 },
        },
      ],
    });
    expect(cloneFindings(differentCaseFolder, 'C:/repo')[0]?.message).toBe(
      'Lines 3-4 repeat C:/Repo/src/x.ts lines 1-2 (10 tokens): keep one copy and share it.',
    );
  });

  it('is an engine error for a report it cannot read', () => {
    expect(() => cloneFindings('not json', '/repo')).toThrow(EngineError);
    expect(() => cloneFindings('{"clones": []}', '/repo')).toThrow(/unknown shape/);
  });
});
