import type { Location } from '../core/finding.js';

/** Inclusive line numbers on the new side of a diff. */
export type LineRange = { readonly start: number; readonly end: number };

export type FileChange = {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly oldPath?: string;
  /** Lines added or changed, on the new side. */
  readonly added: readonly LineRange[];
  /** Lines removed, on the old side. */
  readonly removed: readonly LineRange[];
  /** The diff's added and removed line texts, without their `+`/`-`. */
  readonly addedText: readonly string[];
  readonly removedText: readonly string[];
};

export type ChangeSet = {
  /** Keyed by the path on the new side; a deleted file by its old path. */
  readonly files: ReadonlyMap<string, FileChange>;
};

type Draft = {
  path: string;
  oldPath: string;
  status: FileChange['status'];
  added: LineRange[];
  removed: LineRange[];
  addedText: string[];
  removedText: string[];
  /** Header lines come only before a file's first hunk; inside hunks `--- x` is a removed line. */
  inHunks: boolean;
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '');
}

function startFile(line: string): Draft {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  const oldPath = match?.[1] ?? '';
  return {
    path: match?.[2] ?? oldPath,
    oldPath,
    status: 'modified',
    added: [],
    removed: [],
    addedText: [],
    removedText: [],
    inHunks: false,
  };
}

function range(start: number, count: number): LineRange | undefined {
  return count > 0 ? { start, end: start + count - 1 } : undefined;
}

function readHunk(draft: Draft, line: string): void {
  const match = HUNK.exec(line);
  if (match === null) return;
  const removed = range(Number(match[1]), match[2] === undefined ? 1 : Number(match[2]));
  const added = range(Number(match[3]), match[4] === undefined ? 1 : Number(match[4]));
  if (removed) draft.removed.push(removed);
  if (added) draft.added.push(added);
}

function readHeader(draft: Draft, line: string): void {
  if (line.startsWith('new file mode')) draft.status = 'added';
  else if (line.startsWith('deleted file mode')) draft.status = 'deleted';
  else if (line.startsWith('rename from ')) {
    draft.status = 'renamed';
    draft.oldPath = line.slice('rename from '.length);
  } else if (line.startsWith('rename to ')) draft.path = line.slice('rename to '.length);
  else if (line.startsWith('--- ') && line !== '--- /dev/null') {
    draft.oldPath = stripPrefix(line.slice(4));
  } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
    draft.path = stripPrefix(line.slice(4));
  }
}

function readLine(draft: Draft, line: string): void {
  if (line.startsWith('@@')) {
    draft.inHunks = true;
    readHunk(draft, line);
  } else if (!draft.inHunks) readHeader(draft, line);
  else if (line.startsWith('+')) draft.addedText.push(line.slice(1));
  else if (line.startsWith('-')) draft.removedText.push(line.slice(1));
}

function finish(draft: Draft): FileChange {
  const key = draft.status === 'deleted' ? draft.oldPath : draft.path;
  const renamed = draft.status === 'renamed' || draft.oldPath !== draft.path;
  return {
    path: key,
    status: draft.status === 'modified' && renamed ? 'renamed' : draft.status,
    ...(renamed || draft.status === 'deleted' ? { oldPath: draft.oldPath } : {}),
    added: draft.added,
    removed: draft.removed,
    addedText: draft.addedText,
    removedText: draft.removedText,
  };
}

/** Reads a unified diff (`git diff`, or GitHub's per-file patches joined with headers). */
export function parseDiff(text: string): ChangeSet {
  const files = new Map<string, FileChange>();
  let draft: Draft | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (draft) files.set(...entry(finish(draft)));
      draft = startFile(line);
    } else if (draft) readLine(draft, line);
  }
  if (draft) files.set(...entry(finish(draft)));
  return { files };
}

function entry(change: FileChange): [string, FileChange] {
  return [change.path, change];
}

/** Whether a finding's lines are among those the change added or changed. */
export function touches(changes: ChangeSet, location: Location | undefined): boolean {
  if (location === undefined) return false;
  const change = changes.files.get(location.file);
  if (change === undefined || change.status === 'deleted') return false;
  if (change.status === 'added') return true;
  const end = location.endLine ?? location.line;
  return change.added.some((r) => r.start <= end && location.line <= r.end);
}
