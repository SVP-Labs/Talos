import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepare } from './prepare.js';
import { type Engine, runChecks, type Side } from './run.js';
import { CONFIG_FILE, loadConfig } from '../config/load.js';
import type { TalosConfig } from '../config/schema.js';
import type { Os, Tier } from '../core/check.js';
import { engineErrors, parseRunResult, type RunResult } from '../core/result.js';
import { type ChangeSet, parseDiff } from '../repo/changes.js';
import { repoFacts } from '../repo/facts.js';
import { type Git, git, inWorktree, showFile, trackedFiles } from '../repo/git.js';

export type At = {
  readonly root: string;
  readonly sha: string;
  readonly tiers: readonly Tier[];
  readonly os: Os;
  readonly side: Side;
  readonly changes?: ChangeSet;
  readonly only?: readonly string[];
  /** The `talos.yml` a checkout without one is judged by: the head's. */
  readonly config?: TalosConfig;
};

/** Prepares a checkout and runs the checks there: one `talos run`. */
export async function runAt(engine: Engine, at: At): Promise<RunResult> {
  const config = await loadConfig(at.root, at.config);
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
    ...(at.config !== undefined && config === at.config ? { borrowed: true } : {}),
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

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * A base commit's results don't change; local runs keep them under `.talos/cache`, unless an
 * engine error spoilt them. A commit judged by the head's `talos.yml` is kept under that file's
 * digest too.
 */
export async function cachedRun(
  engine: Engine,
  repo: Git,
  at: Omit<At, 'root'>,
): Promise<RunResult> {
  const cacheDir = join(repo.root, '.talos', 'cache');
  const own = (await showFile(repo, at.sha, CONFIG_FILE)) !== undefined;
  const borrowed = own || at.config === undefined ? '' : `-${digest(JSON.stringify(at.config))}`;
  const name = `${at.sha}-${at.tiers.join('+')}-${at.os}-${engine.version}${borrowed}.json`;
  const file = join(cacheDir, name);
  try {
    return parseRunResult(await readFile(file, 'utf8'));
  } catch {
    const directory = join(repo.root, '.talos', 'worktrees', at.sha);
    const result = await inWorktree(repo, { sha: at.sha, directory }, () =>
      runAt(engine, { ...at, root: directory }),
    );
    if (engineErrors(result).length === 0) {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, JSON.stringify(result));
    }
    return result;
  }
}
