import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createTalosDir } from './talos-dir.js';
import { type Exec, execOk } from '../exec/exec.js';

/** Thin helpers over the git CLI; every path is repository-relative with forward slashes. */
export type Git = {
  readonly root: string;
  run(args: readonly string[]): Promise<string>;
};

export function git(run: Exec, root: string): Git {
  return {
    root,
    run: (args) => execOk(run, 'git', ['-c', 'core.quotepath=off', ...args], { cwd: root }),
  };
}

export async function revParse(repo: Git, rev: string): Promise<string> {
  return (await repo.run(['rev-parse', '--verify', `${rev}^{commit}`])).trim();
}

/** The commits after `base` up to `head`, oldest first. */
export async function revList(repo: Git, base: string, head: string): Promise<string[]> {
  const out = await repo.run(['rev-list', '--reverse', '--topo-order', `${base}..${head}`]);
  return out.split('\n').filter(Boolean);
}

/** A commit's parents, first parent first: none for a root commit, two or more for a merge. */
export async function parentsOf(repo: Git, sha: string): Promise<string[]> {
  return (await repo.run(['log', '-1', '--format=%P', sha])).trim().split(' ').filter(Boolean);
}

export async function mergeBase(repo: Git, a: string, b: string): Promise<string> {
  return (await repo.run(['merge-base', a, b])).trim();
}

export async function trackedFiles(repo: Git): Promise<string[]> {
  const out = await repo.run(['ls-files', '-z', '--cached']);
  return out.split('\0').filter(Boolean);
}

/**
 * The files of a working tree as they stand: the tracked ones still there, and the new ones git
 * doesn't ignore, as the next commit of everything would hold them. A repository nested inside,
 * which git lists as a directory, is not a file of this one.
 */
export async function workingFiles(repo: Git): Promise<string[]> {
  const list = async (flag: string): Promise<string[]> =>
    (await repo.run(['ls-files', '-z', flag, '--exclude-standard'])).split('\0').filter(Boolean);
  const deleted = new Set(await list('--deleted'));
  const tracked = (await list('--cached')).filter((file) => !deleted.has(file));
  const added = (await list('--others')).filter((file) => !file.endsWith('/'));
  return [...new Set([...tracked, ...added])];
}

/** A file's content at a commit, or undefined when it doesn't exist there. */
export async function showFile(repo: Git, sha: string, path: string): Promise<string | undefined> {
  try {
    return await repo.run(['show', `${sha}:${path}`]);
  } catch {
    return undefined;
  }
}

async function removeWorktree(repo: Git, directory: string): Promise<void> {
  await repo.run(['worktree', 'remove', '--force', directory]).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
  await repo.run(['worktree', 'prune']).catch(() => undefined);
}

/**
 * Where this process checks `name` out, under `.talos/worktrees`, which it creates: its process
 * id keeps two runs in one clone, such as a pre-push hook beside a `talos check`, out of each
 * other's checkout.
 */
export async function worktreeDir(
  repo: Git,
  name: string,
  pid: number = process.pid,
): Promise<string> {
  return join(await createTalosDir(repo.root, 'worktrees'), `${name}-${pid}`);
}

/**
 * Runs `work` in a fresh detached worktree of `sha` at `directory`, removed afterwards; one a
 * run before it left behind is cleared first.
 */
export async function inWorktree<T>(
  repo: Git,
  at: { readonly sha: string; readonly directory: string },
  work: () => Promise<T>,
): Promise<T> {
  await removeWorktree(repo, at.directory);
  await mkdir(dirname(at.directory), { recursive: true });
  await repo.run(['worktree', 'add', '--force', '--detach', at.directory, at.sha]);
  try {
    return await work();
  } finally {
    await removeWorktree(repo, at.directory);
  }
}
