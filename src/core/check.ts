import type { Finding } from './finding.js';
import type { Logger } from './log.js';
import type { TalosConfig } from '../config/schema.js';
import type { Exec } from '../exec/exec.js';
import type { ChangeSet } from '../repo/changes.js';
import type { RepoFacts } from '../repo/facts.js';
import type { Tools } from '../tools/tools.js';

export type Lang = 'ts' | 'py' | 'php' | 'lua' | 'rust';
export type Os = 'linux' | 'windows' | 'macos';

/**
 * `commit`: the fast tier, run on every commit of a ready PR and of a merge group.
 * `head`: everything else, run on a PR's head and on its base commit.
 */
export type Tier = 'commit' | 'head';

export type Component = {
  readonly lang: Lang;
  /** Repository-relative, `.` for the root. */
  readonly root: string;
  readonly os: readonly Os[];
};

export type Applicability =
  { readonly applies: true } | { readonly applies: false; readonly reason: string };

export const APPLIES: Applicability = { applies: true };

export function skip(reason: string): Applicability {
  return { applies: false, reason };
}

export type ApplyContext = {
  readonly facts: RepoFacts;
  readonly config: TalosConfig;
  /** Set for checks scoped to a component. */
  readonly component?: Component;
  /** What changed from the base commit to the head commit; absent when nothing is compared. */
  readonly changes?: ChangeSet;
  /** Which end of a comparison this run is, or `alone` when nothing is compared (`talos debt`). */
  readonly side: 'head' | 'base' | 'alone';
};

export type CheckContext = ApplyContext & {
  /** Absolute path of the checkout being judged. */
  readonly root: string;
  /** The commit being judged. */
  readonly sha: string;
  readonly exec: Exec;
  readonly tools: Tools;
  /** An absolute, empty directory of this check's own, for reports and generated files. */
  readonly scratch: string;
  readonly log: Logger;
  readonly os: Os;
  /** Shares work between checks of one run, such as a test run the coverage check reads. */
  readonly memo: Memo;
};

export type Memo = <T>(key: string, compute: () => Promise<T>) => Promise<T>;

export type Check = {
  /** `<area>/<name>`, such as `ts/lint` or `docs/glossary`. */
  readonly id: string;
  readonly tier: Tier;
  /** `component` checks run once per matching component, with `component` set. */
  readonly scope: 'repo' | 'component';
  /** For `component` checks: the languages they serve. */
  readonly langs?: readonly Lang[];
  readonly title: string;
  applies(ctx: ApplyContext): Applicability;
  run(ctx: CheckContext): Promise<readonly Finding[]>;
};

/** Thrown by a check that couldn't judge (a tool missing, output it can't read): a Talos bug. */
export class EngineError extends Error {
  override readonly name = 'EngineError';
}
