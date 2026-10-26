import type { ChangeSet, FileChange, LineRange } from '../../repo/changes.js';

/** What the base commit had at a path: nothing, known text, or something the diff can't tell. */
export type BaseText =
  { readonly known: true; readonly text: string | undefined } | { readonly known: false };

const inside = (ranges: readonly LineRange[], line: number): boolean =>
  ranges.some((range) => range.start <= line && line <= range.end);

const lineCount = (ranges: readonly LineRange[]): number =>
  ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);

/**
 * A file as it was at the base commit, rebuilt from its text at head and its zero-context diff:
 * the head lines outside the added ranges, with the removed lines put back at their old line
 * numbers. A diff whose texts don't match its ranges, or a modified file with no hunks (a patch
 * the API left out as too large), can't be trusted.
 */
export function baseText(head: string, change: FileChange): BaseText {
  if (change.status === 'added') return { known: true, text: undefined };
  const noHunks =
    change.status === 'modified' && change.added.length === 0 && change.removed.length === 0;
  const consistent =
    lineCount(change.added) === change.addedText.length &&
    lineCount(change.removed) === change.removedText.length;
  if (noHunks || !consistent) return { known: false };
  const kept = head.split('\n').filter((_, index) => !inside(change.added, index + 1));
  const removed = change.removedText;
  const lines: string[] = [];
  let next = { kept: 0, removed: 0 };
  for (let line = 1; line <= kept.length + removed.length; line += 1) {
    if (inside(change.removed, line)) {
      lines.push(removed[next.removed] ?? '');
      next = { ...next, removed: next.removed + 1 };
    } else {
      lines.push(kept[next.kept] ?? '');
      next = { ...next, kept: next.kept + 1 };
    }
  }
  return { known: true, text: lines.join('\n') };
}

/** The change to a path, found by its head path or, for a rename, its base path. */
export function changeTo(changes: ChangeSet, path: string): FileChange | undefined {
  return (
    changes.files.get(path) ?? [...changes.files.values()].find((change) => change.oldPath === path)
  );
}
