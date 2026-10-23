import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepare } from './prepare.js';
import { type Engine, runChecks, type Side } from './run.js';
import { loadConfig } from '../config/load.js';
import type { Os, Tier } from '../core/check.js';
import { parseRunResult, type RunResult } from '../core/result.js';
import { type ChangeSet, parseDiff } from '../repo/changes.js';
import { repoFacts } from '../repo/facts.js';
import { addWorktree, type Git, git, trackedFiles } from '../repo/git.js';

export type At = {
  readonly root: string;
  readonly sha: string;
  readonly tiers: readonly Tier[];
  readonly os: Os;
  readonly side: Side;
  readonly changes?: ChangeSet;
  readonly only?: readonly string[];
};

/** Prepares a checkout and runs the checks there: one `talos run`. */
export async function runAt(engine: Engine, at: At): Promise<RunResult> {
  const config = await loadConfig(at.root);
  const facts = repoFacts(await trackedFiles(git(engine.exec, at.root)), config.exclude);
  const plan = {
    root: at.root,
    sha: at.sha,
    tiers: at.tiers,
    os: at.os,
    side: at.side,
    config,
    facts,
    ...(at.changes ? { changes: at.changes } : {}),
    ...(at.only ? { only: at.only } : {}),
  };
  const prepared = await prepare(engine, plan);
  try {
    return await runChecks(engine, { ...plan, failedInstalls: prepared.failedInstalls });
  } finally {
    await prepared.release();
  }
}

export async function changesBetween(repo: Git, from: string, to?: string): Promise<ChangeSet> {
  const args = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '-U0',
    '-M',
    from,
    ...(to === undefined ? [] : [to]),
  ];
  return parseDiff(await repo.run(args));
}

/** A base commit's results don't change; local runs keep them under `.talos/cache`. */
export async function cachedRun(
  engine: Engine,
  repo: Git,
  at: Omit<At, 'root'>,
): Promise<RunResult> {
  const cacheDir = join(repo.root, '.talos', 'cache');
  const file = join(cacheDir, `${at.sha}-${at.tiers.join('+')}-${at.os}-${engine.version}.json`);
  try {
    return parseRunResult(await readFile(file, 'utf8'));
  } catch {
    const directory = join(repo.root, '.talos', 'worktrees', at.sha);
    await mkdir(join(repo.root, '.talos', 'worktrees'), { recursive: true });
    await addWorktree(repo, at.sha, directory);
    const result = await runAt(engine, { ...at, root: directory });
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, JSON.stringify(result));
    return result;
  }
}
