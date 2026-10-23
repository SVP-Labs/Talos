import { describe, expect, it } from 'vitest';
import { startDraft } from './draft.js';

describe('startDraft', () => {
  const texts: Record<string, string> = { 'a.txt': 'a\n', 'b.txt': 'b\n' };

  it('reads through its own writes and deletions', () => {
    const draft = startDraft(Object.keys(texts), (path) => texts[path]);
    draft.write('c.txt', 'c\n', 'brief');
    draft.remove('b.txt', 'migrated');
    expect(draft.read('c.txt')).toBe('c\n');
    expect(draft.read('b.txt')).toBeUndefined();
    expect(draft.has('b.txt')).toBe(false);
    expect(draft.files()).toEqual(['a.txt', 'c.txt']);
  });

  it('reports only real changes, each file under the first reason it was touched for', () => {
    const draft = startDraft(Object.keys(texts), (path) => texts[path]);
    draft.write('a.txt', 'a\n', 'generated');
    draft.write('c.txt', 'one\n', 'migration');
    draft.write('c.txt', 'two\n', 'dev-dependencies');
    draft.remove('gone.txt', 'shadowed');
    draft.remove('b.txt', 'migrated');
    draft.write('b.txt', 'b2\n', 'generated');
    draft.next('step');
    draft.next('step');
    expect(draft.done()).toEqual({
      write: [
        { path: 'c.txt', content: 'two\n', why: 'migration' },
        { path: 'b.txt', content: 'b2\n', why: 'generated' },
      ],
      delete: [],
      next: ['step'],
    });
  });
});
