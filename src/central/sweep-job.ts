import { z } from 'zod';
import { isGoverned, openTalosIssues, soleRepository } from './repos.js';
import type { RuntimeAssessor } from './runtime-port.js';
import {
  groupAlerts,
  isRuntimeFile,
  SECURITY_LABEL,
  securityIssue,
  sweepPaths,
  unfiled,
} from './sweep.js';
import type { GitHub } from '../github/api.js';
import { readFileAt } from '../github/contents.js';
import type { Identities } from '../github/identities.js';
import { fileIssue } from '../jobs/talos-issues.js';

export type SweepDeps = {
  /** `talos-reviewer`, limited to one repository: contents read, issues write. */
  readonly gh: GitHub;
  readonly who: Identities;
  readonly assess: RuntimeAssessor;
};

/** Counts only: a public log may show nothing else about a repository. */
export type SweepReport = {
  readonly governed: number;
  readonly files: number;
  readonly alerts: number;
  readonly filed: number;
  readonly open: number;
  /** What went wrong, a tree GitHub listed only in part included. */
  readonly errors: number;
  /** Declaring files left unread past the cap: the sweep didn't cover them. */
  readonly skipped: number;
};

const treeSchema = z.object({
  truncated: z.boolean().default(false),
  tree: z.array(z.object({ path: z.string(), type: z.string() })),
});

/** The default branch's files that can declare a runtime, through the trees API. */
async function runtimePaths(
  gh: GitHub,
  repo: string,
  branch: string,
): Promise<{ read: string[]; skipped: number; truncated: boolean }> {
  const raw = await gh.request<unknown>(
    'GET',
    `repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  const tree = treeSchema.parse(raw);
  const paths = tree.tree
    .filter((entry) => entry.type === 'blob' && isRuntimeFile(entry.path))
    .map((entry) => entry.path);
  return { ...sweepPaths(paths), truncated: tree.truncated };
}

const NONE: SweepReport = {
  governed: 0,
  files: 0,
  alerts: 0,
  filed: 0,
  open: 0,
  errors: 0,
  skipped: 0,
};

/**
 * One repository's sweep: read its runtime declarations, ask the runtime pack, and file one p0
 * `security` issue per vulnerable runtime that no open Talos issue already covers.
 */
export async function runSweep(deps: SweepDeps): Promise<SweepReport> {
  const repository = await soleRepository(deps.gh);
  if (!isGoverned(repository)) return NONE;
  const repo = repository.fullName;
  const branch = repository.defaultBranch;
  const { read: paths, skipped, truncated } = await runtimePaths(deps.gh, repo, branch);
  const texts = await Promise.all(paths.map((path) => readFileAt(deps.gh, repo, path, branch)));
  const files = new Map<string, string>();
  for (const [index, path] of paths.entries()) {
    const text = texts[index];
    if (text !== undefined) files.set(path, text);
  }
  const assessment = await deps.assess(files);
  const groups = groupAlerts(assessment.alerts);
  const open = await openTalosIssues(deps.gh, { repo, who: deps.who }, SECURITY_LABEL);
  const fresh = unfiled(groups, open);
  for (const group of fresh) await fileIssue(deps.gh, repo, securityIssue(group));
  return {
    governed: 1,
    files: files.size,
    alerts: groups.length,
    filed: fresh.length,
    open: open.length,
    errors: assessment.errors + (truncated ? 1 : 0),
    skipped,
  };
}
