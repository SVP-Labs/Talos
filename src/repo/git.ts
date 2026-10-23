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

export async function parentOf(repo: Git, sha: string): Promise<string> {
  return revParse(repo, `${sha}^`);
}

export async function mergeBase(repo: Git, a: string, b: string): Promise<string> {
  return (await repo.run(['merge-base', a, b])).trim();
}

export async function trackedFiles(repo: Git): Promise<string[]> {
  const out = await repo.run(['ls-files', '-z', '--cached']);
  return out.split('\0').filter(Boolean);
}

/** A file's content at a commit, or undefined when it doesn't exist there. */
export async function showFile(repo: Git, sha: string, path: string): Promise<string | undefined> {
  try {
    return await repo.run(['show', `${sha}:${path}`]);
  } catch {
    return undefined;
  }
}

export async function addWorktree(repo: Git, sha: string, directory: string): Promise<void> {
  await repo.run(['worktree', 'add', '--force', '--detach', directory, sha]);
}
