import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Command, parse } from './io.js';
import { currentOs } from './run.js';
import { engineErrors, parseRunResult, type RunResult } from '../core/result.js';
import { runAt } from '../engine/local.js';
import type { Engine } from '../engine/run.js';
import { createEngine } from '../engine/session.js';
import { compactDebt, debtCheckIds, debtReport, debtText } from '../jobs/debt-report.js';
import { type Git, git, inWorktree, revParse, worktreeDir } from '../repo/git.js';
import { createTalosDir, talosPath } from '../repo/talos-dir.js';

/** Where the default branch is, in order: what `origin` says, then the usual name. */
const DEFAULT_TIPS = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/heads/main'];

async function tipOf(repo: Git, ref: string | undefined): Promise<string> {
  if (ref !== undefined) return revParse(repo, ref);
  const listed = (await repo.run(['for-each-ref', '--format=%(refname)', ...DEFAULT_TIPS])).split(
    '\n',
  );
  const found = DEFAULT_TIPS.find((tip) => listed.includes(tip));
  if (found === undefined) throw new Error('no default branch found: pass --ref <ref>');
  return revParse(repo, found);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * The checks at a commit with nothing to compare against, in a worktree of their own under
 * `.talos/`. A run without engine errors is kept, since a commit's findings don't change.
 */
async function aloneAt(engine: Engine, repo: Git, sha: string): Promise<RunResult> {
  const os = currentOs();
  const name = `${sha}-debt-${os}-${engine.version}.json`;
  const cached = talosPath(repo.root, 'cache', name);
  if (await exists(cached)) return parseRunResult(await readFile(cached, 'utf8'));
  const directory = await worktreeDir(repo, `debt-${sha}`);
  const result = await inWorktree(repo, { sha, directory }, () =>
    runAt(engine, {
      root: directory,
      sha,
      tiers: ['commit', 'head'],
      os,
      side: 'alone',
      only: debtCheckIds(engine.packs),
    }),
  );
  if (engineErrors(result).length === 0) {
    await writeFile(join(await createTalosDir(repo.root, 'cache'), name), JSON.stringify(result));
  }
  return result;
}

/** `talos debt` with an engine of the caller's choosing (tests pass one with test packs). */
export function debtWith(makeEngine: (verbose: boolean) => Engine): Command {
  return async (argv, io) => {
    const { values } = parse(argv, {
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
      ref: { type: 'string' },
      verbose: { type: 'boolean', default: false },
    });
    const engine = makeEngine(values.verbose);
    const repo = git(engine.exec, io.cwd);
    const sha = await tipOf(repo, values.ref);
    const report = debtReport(await aloneAt(engine, repo, sha), { now: new Date() });
    if (values.out !== undefined) {
      await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
    }
    io.out(values.json ? `${JSON.stringify(compactDebt(report), null, 2)}\n` : debtText(report));
    return report.counts.faults > 0 ? 2 : 0;
  };
}

/**
 * `talos debt`: the findings on the default branch, with nothing compared. `--json` prints the
 * counts by rule and file (`talos.debt/1`, lists capped at 20); `--out` writes every finding.
 * Exits 0, or 2 when a check had an engine error and the list is incomplete.
 */
export const debt: Command = debtWith(createEngine);
