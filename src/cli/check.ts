import { type Command, parse } from './io.js';
import { currentOs } from './run.js';
import { loadConfig } from '../config/load.js';
import type { RunResult } from '../core/result.js';
import { commitFindings, comparisonsFor, compactVerdict } from '../engine/gate.js';
import { cachedRun, changesBetween, runAt } from '../engine/local.js';
import { type GatePlan, planRange } from '../engine/plan.js';
import { textReport } from '../engine/report.js';
import type { Engine } from '../engine/run.js';
import { createEngine } from '../engine/session.js';
import { decide, exitCode } from '../engine/verdict.js';
import { type Git, git, revParse } from '../repo/git.js';

async function defaultBase(repo: Git): Promise<string> {
  for (const ref of ['origin/HEAD', 'origin/main', 'main']) {
    try {
      return await revParse(repo, ref);
    } catch {
      continue;
    }
  }
  throw new Error('no base to compare with: pass --base <ref>');
}

async function runAll(
  engine: Engine,
  repo: Git,
  plan: GatePlan,
  only?: string[],
): Promise<RunResult[]> {
  const os = currentOs();
  const results: RunResult[] = [];
  for (const spec of plan.runs.filter((r) => r.os === os)) {
    const common = { sha: spec.sha, tiers: spec.tiers, os, ...(only ? { only } : {}) };
    if (spec.sha === plan.head) {
      const changes = await changesBetween(repo, plan.base);
      results.push(await runAt(engine, { ...common, root: repo.root, side: 'head', changes }));
    } else {
      const side = spec.sha === plan.base ? 'base' : 'head';
      results.push(await cachedRun(engine, repo, { ...common, side }));
    }
  }
  return results;
}

/**
 * `talos check`: what the gate would say, locally, before a push. The working tree is judged
 * against the base branch; `--commits` judges every commit against its parent as a ready PR's
 * gate does. `--json` prints the compact verdict an agent reads (`talos.verdict/1`).
 */
export const check: Command = async (argv, io) => {
  const { values } = parse(argv, {
    base: { type: 'string' },
    commits: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    only: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  });
  const engine = createEngine(values.verbose);
  const repo = git(engine.exec, io.cwd);
  const config = await loadConfig(io.cwd);
  const tipOfBase =
    values.base === undefined ? await defaultBase(repo) : await revParse(repo, values.base);
  const plan = await planRange(repo, config, {
    mode: values.commits ? 'ready' : 'draft',
    tipOfBase,
    head: 'HEAD',
  });
  const results = await runAll(engine, repo, plan, values.only?.split(','));
  const comparisons = (await comparisonsFor(repo, plan)).map(async (c) =>
    c.sha === plan.head && c.against === plan.base
      ? { ...c, changes: await changesBetween(repo, plan.base) }
      : c,
  );
  const decided = decide(
    results,
    await Promise.all(comparisons),
    await commitFindings(repo, plan, config),
  );
  if (values.json) {
    const compact = compactVerdict(decided, {
      talos: engine.version,
      mode: plan.mode,
      base: plan.base,
      head: plan.head,
    });
    io.out(`${JSON.stringify(compact, null, 2)}\n`);
  } else {
    io.out(textReport(decided));
  }
  return exitCode(decided);
};
