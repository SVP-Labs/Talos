import type { Reader } from './scaffold.js';

/** Why adoption writes a file: the first reason any of its steps touched it. */
export type Why =
  | 'talos.yml'
  | 'generated'
  | 'extension'
  | 'claude'
  | 'issue-form'
  | 'pr-template'
  | 'dependabot'
  | 'dev-dependencies'
  | 'migration'
  | 'supply-chain'
  | 'patch'
  | 'line-endings'
  | 'ignore'
  | 'lints'
  | 'toolchain'
  | 'brief';

/** A file adoption writes, and why. */
export type PlannedFile = { readonly path: string; readonly content: string; readonly why: Why };

/** Why adoption deletes a file. */
export type Gone = 'scaffold' | 'pr-template' | 'shadowed' | 'migrated';

export type Deletion = { readonly path: string; readonly why: Gone };

/**
 * The working tree as adoption leaves it, built up step by step: the repository's files with
 * every planned write and deletion on top, so each step reads what the steps before it wrote.
 */
export type Draft = {
  read: Reader;
  /** Whether the file is there after the steps so far, tracked or merely on disk. */
  has(path: string): boolean;
  /** The tracked files after the steps so far, with the planned ones. */
  files(): string[];
  write(path: string, content: string, why: Why): void;
  remove(path: string, why: Gone): void;
  /** A step whoever commits must take first, once. */
  next(step: string): void;
};

export type DraftResult = {
  /** Only files whose content changes. */
  readonly write: PlannedFile[];
  readonly delete: Deletion[];
  readonly next: string[];
};

type State = {
  readonly writes: Map<string, PlannedFile>;
  readonly removed: Map<string, Gone>;
  readonly next: string[];
};

export function startDraft(
  files: readonly string[],
  read: Reader,
): Draft & { done(): DraftResult } {
  const state: State = { writes: new Map(), removed: new Map(), next: [] };
  const draftRead: Reader = (path) => {
    if (state.removed.has(path)) return undefined;
    return state.writes.get(path)?.content ?? read(path);
  };
  const present = (): string[] => [
    ...new Set([...files.filter((file) => !state.removed.has(file)), ...state.writes.keys()]),
  ];
  return {
    read: draftRead,
    has: (path) => present().includes(path) || draftRead(path) !== undefined,
    files: present,
    write: (path, content, why) => {
      state.removed.delete(path);
      state.writes.set(path, { path, content, why: state.writes.get(path)?.why ?? why });
    },
    remove: (path, why) => {
      state.writes.delete(path);
      state.removed.set(path, why);
    },
    next: (step) => {
      if (!state.next.includes(step)) state.next.push(step);
    },
    done: () => ({
      write: [...state.writes.values()].filter((file) => read(file.path) !== file.content),
      delete: [...state.removed]
        .filter(([path]) => files.includes(path) || read(path) !== undefined)
        .map(([path, why]) => ({ path, why })),
      next: [...state.next],
    }),
  };
}
