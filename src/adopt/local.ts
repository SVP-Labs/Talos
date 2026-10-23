import { readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type { AdoptPlan } from './plan.js';
import type { Reader } from './scaffold.js';
import type { Exec } from '../exec/exec.js';
import { git, trackedFiles } from '../repo/git.js';

/**
 * Adoption's effects on the working tree and the local clone. None of them talks to GitHub, so
 * they run where no token is held (Thea's tasks), and none runs repository code.
 */

export type Tree = { readonly files: readonly string[]; readonly read: Reader };

const MAX_READ = 2_000_000;

function readText(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size <= MAX_READ ? readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function present(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The tracked files of the clone at `root` that are still in its working tree, and a reader over
 * the tree, so a plan made after an uncommitted adoption sees the files gone that it deleted.
 */
export async function readTree(root: string, run: Exec): Promise<Tree> {
  const tracked = await trackedFiles(git(run, root));
  const files = tracked.filter((file) => present(join(root, file)));
  const cache = new Map<string, string | undefined>();
  const read: Reader = (path) => {
    if (!cache.has(path)) cache.set(path, readText(join(root, safePath(path))));
    return cache.get(path);
  };
  return { files, read };
}

/** A path inside the repository, refused otherwise: a plan never writes outside the clone. */
export function safePath(path: string): string {
  const normal = posix.normalize(path.replaceAll('\\', '/'));
  if (normal.startsWith('/') || normal === '..' || normal.startsWith('../') || normal === '.') {
    throw new Error(`refusing a path outside the repository: ${path}`);
  }
  return normal;
}

/**
 * Deletes first, then writes: on a file system that ignores case, a file deleted under one
 * spelling would otherwise take the one written under another with it.
 */
export async function applyPlan(root: string, plan: AdoptPlan): Promise<void> {
  for (const deletion of plan.delete) {
    await rm(join(root, safePath(deletion.path)), { force: true });
  }
  for (const file of plan.write) {
    const path = join(root, safePath(file.path));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
}

/** Whether the working tree has no changes, staged or not, that adoption would sweep up. */
export async function isClean(root: string, run: Exec): Promise<boolean> {
  return (await git(run, root).run(['status', '--porcelain'])).trim() === '';
}

/** Checks out the claimed branch, from the remote's copy when there is no local one yet. */
export async function checkoutClaim(root: string, run: Exec, branch: string): Promise<void> {
  const repo = git(run, root);
  const local = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: root,
  });
  if (local.code === 0) {
    await repo.run(['switch', branch]);
    return;
  }
  await repo.run(['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  await repo.run(['switch', '-c', branch, '--track', `origin/${branch}`]);
}

/** Stages exactly `paths` and commits them; `false` when there was nothing to commit. */
export async function commitPaths(
  root: string,
  run: Exec,
  paths: readonly string[],
  subject: string,
): Promise<boolean> {
  const repo = git(run, root);
  if (paths.length > 0) await repo.run(['add', '-A', '--', ...paths]);
  const staged = await run('git', ['diff', '--cached', '--quiet'], { cwd: root });
  if (staged.code === 0) return false;
  await repo.run(['commit', '-m', subject]);
  return true;
}

export async function pushBranch(root: string, run: Exec, branch: string): Promise<void> {
  await git(run, root).run(['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
}
