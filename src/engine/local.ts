import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepare } from './prepare.js';
import { type Engine, runChecks, type Side } from './run.js';
import { CONFIG_FILE, loadConfig } from '../config/load.js';
import type { TalosConfig } from '../config/schema.js';
import type { Os, Tier } from '../core/check.js';
import { engineErrors, parseRunResult, type RunResult } from '../core/result.js';
import { type ChangeSet, parseDiff } from '../repo/changes.js';
import { repoFacts } from '../repo/facts.js';
import {
  type Git,
  git,
  inWorktree,
  showFile,
  trackedFiles,
  workingFiles,
  worktreeDir,
} from '../repo/git.js';
import { createTalosDir, talosPath } from '../repo/talos-dir.js';

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
  /** The root is a working tree judged as it stands, uncommitted files included. */
  readonly workingTree?: boolean;
  /** Mutation covers every component's whole tree, whatever `mutation` lists: the weekly report. */
  readonly mutateAll?: boolean;
};

/** The configuration with every component's root as a mutation path. */
function mutatingAll(config: TalosConfig): TalosConfig {
  return { ...config, mutation: [...new Set(config.components.map((c) => c.root))] };
}

/** Prepares a checkout and runs the checks there: one `talos run`. */
export async function runAt(engine: Engine, at: At): Promise<RunResult> {
  const loaded = await loadConfig(at.root, at.config);
  const config = at.mutateAll === true ? mutatingAll(loaded) : loaded;
  const repo = git(engine.exec, at.root);
  const files = at.workingTree === true ? await workingFiles(repo) : await trackedFiles(repo);
  const facts = repoFacts(files, config.exclude);
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
    ...(at.config !== undefined && loaded === at.config ? { borrowed: true } : {}),
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

export type CachedAt = Omit<At, 'root' | 'workingTree'> & {
  /** What the running engine is, when its version doesn't say: a build under development. */
  readonly build?: string;
};

/**
 * What a run's result depends on beyond its commit, tiers, OS and engine: the checks `--only`
 * names, the change it is judged with (mutation and the lockfile checks judge what it touches),
 * and the day, since the vendors' feeds move.
 */
function circumstances(at: CachedAt): string {
  const changes = at.changes === undefined ? null : [...at.changes.files.values()];
  const day = new Date().toISOString().slice(0, 10);
  return digest(JSON.stringify({ only: at.only ?? null, changes, day }));
}

/**
 * A commit's results don't change under the same circumstances; local runs keep them under
 * `.talos/cache`, unless an engine error spoilt them. A commit judged by the head's `talos.yml` is
 * kept under that file's digest too.
 */
export async function cachedRun(engine: Engine, repo: Git, at: CachedAt): Promise<RunResult> {
  const own = (await showFile(repo, at.sha, CONFIG_FILE)) !== undefined;
  const borrowed = own || at.config === undefined ? '' : `-${digest(JSON.stringify(at.config))}`;
  const which = `${at.os}-${at.build ?? engine.version}${borrowed}`;
  const name = `${at.sha}-${at.tiers.join('+')}-${which}-${circumstances(at)}.json`;
  try {
    return parseRunResult(await readFile(talosPath(repo.root, 'cache', name), 'utf8'));
  } catch {
    const directory = await worktreeDir(repo, at.sha);
    const result = await inWorktree(repo, { sha: at.sha, directory }, () =>
      runAt(engine, { ...at, root: directory }),
    );
    if (engineErrors(result).length === 0) {
      await writeFile(join(await createTalosDir(repo.root, 'cache'), name), JSON.stringify(result));
    }
    return result;
  }
}
