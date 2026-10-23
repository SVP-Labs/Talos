import { describe, expect, it } from 'vitest';
import type { LineCoverage } from './coverage.js';
import { CHANGED_LINES_FLOOR, changedLinesFinding, uncoveredFindings } from './lines.js';
import type { ChangeSet, FileChange } from '../repo/changes.js';

function coverage(files: Record<string, [number[], number[]]>): LineCoverage {
  return new Map(
    Object.entries(files).map(([file, [executable, covered]]) => [
      file,
      { executable: new Set(executable), covered: new Set(covered) },
    ]),
  );
}

function change(path: string, fields: Partial<FileChange>): FileChange {
  return {
    path,
    status: 'modified',
    added: [],
    removed: [],
    addedText: [],
    removedText: [],
    ...fields,
  };
}

function changes(...files: FileChange[]): ChangeSet {
  return { files: new Map(files.map((file) => [file.path, file])) };
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

describe('uncoveredFindings', () => {
  it('reports each executable line no test ran, in file and line order, as lost coverage', () => {
    const findings = uncoveredFindings(
      coverage({ 'src/b.ts': [[3, 1], [1]], 'src/a.ts': [[2, 5, 4], [4]] }),
    );
    expect(findings.map((f) => `${f.location?.file ?? ''}:${f.location?.line ?? 0}`)).toEqual([
      'src/a.ts:2',
      'src/a.ts:5',
      'src/b.ts:3',
    ]);
    expect(findings[0]).toEqual({
      rule: 'coverage/uncovered',
      message: 'No test runs line 2.',
      location: { file: 'src/a.ts', line: 2 },
      policy: 'lost',
    });
  });

  it('reports nothing when every line ran', () => {
    expect(
      uncoveredFindings(
        coverage({
          'a.py': [
            [1, 2],
            [1, 2],
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe('changedLinesFinding', () => {
  it('needs 90% of the executable lines a change adds or edits', () => {
    expect(CHANGED_LINES_FLOOR).toBe(90);
    const lines = coverage({ 'a.ts': [range(1, 10), range(1, 9)] });
    const edit = changes(change('a.ts', { added: [{ start: 1, end: 10 }] }));
    expect(changedLinesFinding(lines, edit)).toBeUndefined();
    const less = coverage({ 'a.ts': [range(1, 10), range(1, 8)] });
    expect(changedLinesFinding(less, edit)).toEqual({
      rule: 'coverage/changed-lines',
      message:
        'Tests cover 8 of the 10 executable lines this change adds or edits (80%, 90% needed); ' +
        'uncovered: a.ts:9, a.ts:10.',
      key: 'a.ts:9-10',
      policy: 'always',
    });
  });

  it('counts only executable lines, of files the coverage knows, that still exist', () => {
    const lines = coverage({ 'a.ts': [[2, 4], [2]], 'b.ts': [[1], []] });
    const edit = changes(
      change('a.ts', { added: [{ start: 1, end: 3 }] }),
      change('b.ts', { status: 'deleted', removed: [{ start: 1, end: 1 }] }),
      change('README.md', { added: [{ start: 1, end: 5 }] }),
    );
    expect(changedLinesFinding(lines, edit)).toBeUndefined();
    expect(
      changedLinesFinding(lines, changes(change('c.ts', { status: 'added' }))),
    ).toBeUndefined();
  });

  it('lists ten uncovered lines and counts the rest, across files', () => {
    const lines = coverage({ 'a.ts': [range(1, 8), []], 'b.ts': [range(1, 6), [6]] });
    const edit = changes(
      change('b.ts', { added: [{ start: 1, end: 6 }] }),
      change('a.ts', { status: 'added', added: [{ start: 1, end: 8 }] }),
    );
    const finding = changedLinesFinding(lines, edit);
    expect(finding?.message).toBe(
      'Tests cover 1 of the 14 executable lines this change adds or edits (7%, 90% needed); ' +
        'uncovered: a.ts:1, a.ts:2, a.ts:3, a.ts:4, a.ts:5, a.ts:6, a.ts:7, a.ts:8, b.ts:1, ' +
        'b.ts:2 and 3 more.',
    );
    expect(finding?.key).toBe('a.ts:1-8 b.ts:1-5');
  });
});
