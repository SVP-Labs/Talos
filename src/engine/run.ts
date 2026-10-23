import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { TalosConfig } from '../config/schema.js';
import type { Check, CheckContext, Component, Memo, Os, Tier } from '../core/check.js';
import type { Finding, Reported } from '../core/finding.js';
import { fingerprint, identity } from '../core/fingerprint.js';
import type { Logger } from '../core/log.js';
import type { Pack } from '../core/pack.js';
import type { Outcome, RunResult } from '../core/result.js';
import type { Exec } from '../exec/exec.js';
import type { ChangeSet } from '../repo/changes.js';
import type { RepoFacts } from '../repo/facts.js';
import type { Tools } from '../tools/tools.js';

export type Engine = {
  readonly exec: Exec;
  readonly tools: Tools;
  readonly log: Logger;
  readonly version: string;
  readonly packs: readonly Pack[];
};

export type Side = 'head' | 'base' | 'alone';

export type RunPlan = {
  /** Absolute path of the checkout. */
  readonly root: string;
  readonly sha: string;
  readonly tiers: readonly Tier[];
  readonly os: Os;
  readonly side: Side;
  readonly config: TalosConfig;
  readonly facts: RepoFacts;
  /** From the base commit to the head commit, on both sides of a comparison. */
  readonly changes?: ChangeSet;
  /** Runs only these check ids. */
  readonly only?: readonly string[];
  readonly concurrency?: number;
};

type Task = { readonly check: Check; readonly component?: Component };

/** Repository-wide checks run once, on Linux; a component's checks on each OS it declares. */
export function tasksFor(packs: readonly Pack[], plan: RunPlan): Task[] {
  const wanted = (check: Check): boolean =>
    plan.tiers.includes(check.tier) && (plan.only === undefined || plan.only.includes(check.id));
  return packs.flatMap((pack) =>
    pack.checks.filter(wanted).flatMap((check): Task[] => {
      if (check.scope === 'repo') return plan.os === 'linux' ? [{ check }] : [];
      return plan.config.components
        .filter((c) => (check.langs ?? []).includes(c.lang) && c.os.includes(plan.os))
        .map((component) => ({ check, component }));
    }),
  );
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** Checks report repository-relative paths; an absolute one under the checkout is made relative. */
export function repoPath(root: string, file: string): string {
  return toPosix(isAbsolute(file) ? relative(root, file) : file.replace(/^\.\//, ''));
}

function memoizer(): Memo {
  const cache = new Map<string, Promise<unknown>>();
  return async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
    const known = cache.get(key) as Promise<T> | undefined;
    if (known !== undefined) return known;
    const started = compute();
    cache.set(key, started);
    return started;
  };
}

function linesReader(root: string): (file: string) => Promise<readonly string[] | undefined> {
  const cache = new Map<string, Promise<readonly string[] | undefined>>();
  return async (file) => {
    let lines = cache.get(file);
    if (lines === undefined) {
      lines = readFile(join(root, file), 'utf8').then(
        (text) => text.split(/\r?\n/),
        () => undefined,
      );
      cache.set(file, lines);
    }
    return lines;
  };
}

async function report(
  finding: Finding,
  check: string,
  root: string,
  lines: (file: string) => Promise<readonly string[] | undefined>,
): Promise<Reported> {
  const location =
    finding.location === undefined
      ? undefined
      : { ...finding.location, file: repoPath(root, finding.location.file) };
  const text = location === undefined ? undefined : await lines(location.file);
  const located: Finding = location === undefined ? finding : { ...finding, location };
  return {
    ...located,
    check,
    policy: finding.policy ?? 'standard',
    fingerprint: fingerprint(finding.rule, identity(located, text)),
  };
}

type Shared = {
  readonly engine: Engine;
  readonly plan: RunPlan;
  readonly memo: Memo;
  readonly lines: (file: string) => Promise<readonly string[] | undefined>;
  readonly scratchRoot: string;
};

async function runTask(shared: Shared, task: Task): Promise<Outcome> {
  const { engine, plan } = shared;
  const started = performance.now();
  const base = {
    check: task.check.id,
    tier: task.check.tier,
    ...(task.component ? { component: task.component.root } : {}),
  };
  const applyContext = {
    facts: plan.facts,
    config: plan.config,
    side: plan.side,
    tiers: plan.tiers,
    ...(task.component ? { component: task.component } : {}),
    ...(plan.changes ? { changes: plan.changes } : {}),
  };
  const applicability = task.check.applies(applyContext);
  if (!applicability.applies) {
    return {
      ...base,
      status: 'skipped',
      reason: applicability.reason,
      durationMs: 0,
      findings: [],
    };
  }
  const scratch = await mkdtemp(join(shared.scratchRoot, `${task.check.id.replaceAll('/', '-')}-`));
  const ctx: CheckContext = {
    ...applyContext,
    root: plan.root,
    sha: plan.sha,
    exec: engine.exec,
    tools: engine.tools,
    scratch,
    log: engine.log,
    os: plan.os,
    memo: shared.memo,
  };
  try {
    const raw = await task.check.run(ctx);
    const findings = await Promise.all(
      raw.map((f) => report(f, task.check.id, plan.root, shared.lines)),
    );
    const durationMs = Math.round(performance.now() - started);
    return { ...base, status: findings.length > 0 ? 'findings' : 'passed', durationMs, findings };
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const reason = error instanceof Error ? error.message : String(error);
    return { ...base, status: 'error', reason, durationMs, findings: [] };
  }
}

async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Runs every applicable check of the plan's tiers at one checkout; never throws for a check. */
export async function runChecks(engine: Engine, plan: RunPlan): Promise<RunResult> {
  const scratchRoot = await mkdtemp(join(tmpdir(), `talos-${plan.sha.slice(0, 8)}-`));
  const shared: Shared = {
    engine,
    plan,
    memo: memoizer(),
    lines: linesReader(plan.root),
    scratchRoot,
  };
  const tasks = tasksFor(engine.packs, plan);
  engine.log.debug(`${tasks.length} checks at ${plan.sha.slice(0, 12)} (${plan.tiers.join(', ')})`);
  const outcomes = await pool(tasks, plan.concurrency ?? 2, async (task) => {
    const outcome = await runTask(shared, task);
    const at = outcome.component === undefined ? '' : `@${outcome.component}`;
    engine.log.debug(`${outcome.check}${at}: ${outcome.status}`);
    return outcome;
  });
  return { talos: engine.version, sha: plan.sha, tiers: [...plan.tiers], os: plan.os, outcomes };
}
