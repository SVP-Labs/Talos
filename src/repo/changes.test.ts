import { describe, expect, it } from 'vitest';
import { parseDiff, touches } from './changes.js';

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -2,0 +3,2 @@',
  '+one',
  '+two',
  '@@ -10 +11,0 @@',
  '-gone',
  'diff --git a/new.ts b/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.ts',
  '@@ -0,0 +1 @@',
  '+hello',
  'diff --git a/old.ts b/old.ts',
  'deleted file mode 100644',
  '--- a/old.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/x.ts b/y.ts',
  'similarity index 90%',
  'rename from x.ts',
  'rename to y.ts',
].join('\n');

describe('parseDiff', () => {
  const changes = parseDiff(diff);

  it('reads added ranges, removed ranges and their text', () => {
    const a = changes.files.get('src/a.ts');
    expect(a).toMatchObject({
      status: 'modified',
      added: [{ start: 3, end: 4 }],
      removed: [{ start: 10, end: 10 }],
    });
    expect(a?.addedText).toEqual(['one', 'two']);
    expect(a?.removedText).toEqual(['gone']);
  });

  it('knows added, deleted and renamed files', () => {
    expect(changes.files.get('new.ts')?.status).toBe('added');
    expect(changes.files.get('old.ts')?.status).toBe('deleted');
    expect(changes.files.get('y.ts')).toMatchObject({ status: 'renamed', oldPath: 'x.ts' });
  });

  it('tells which findings sit on changed lines', () => {
    expect(touches(changes, { file: 'src/a.ts', line: 4 })).toBe(true);
    expect(touches(changes, { file: 'src/a.ts', line: 1, endLine: 2 })).toBe(false);
    expect(touches(changes, { file: 'src/a.ts', line: 1, endLine: 3 })).toBe(true);
    expect(touches(changes, { file: 'new.ts', line: 40 })).toBe(true);
    expect(touches(changes, { file: 'other.ts', line: 1 })).toBe(false);
  });
});

describe('parseDiff inside hunks', () => {
  it('reads lines that look like headers as content', () => {
    const changes = parseDiff(
      [
        'diff --git a/a.lua b/a.lua',
        '--- a/a.lua',
        '+++ b/a.lua',
        '@@ -1 +1 @@',
        '--- a comment removed',
        '+++ counter',
      ].join('\n'),
    );
    expect(changes.files.get('a.lua')).toMatchObject({
      path: 'a.lua',
      removedText: ['-- a comment removed'],
      addedText: ['++ counter'],
    });
  });
});
