import type { TalosConfig } from '../config/schema.js';
import type { Logger } from '../core/log.js';
import type { GitHub } from '../github/api.js';
import type { Identities } from '../github/identities.js';

/**
 * `analyze` runs repository code (the default branch's tests and configs) and holds no secret;
 * `act` holds the reviewer App's token and never runs repository code. A job that needs both
 * reads what `analyze` left in `workdir`.
 */
export type JobPhase = 'analyze' | 'act';

export type JobContext = {
  /** `GITHUB_EVENT_NAME`. */
  readonly event: string;
  /** The parsed `GITHUB_EVENT_PATH`: data from GitHub, validated before use. */
  readonly payload: unknown;
  /** `owner/name`. */
  readonly repo: string;
  readonly phase: JobPhase;
  /** The reviewer App's token, limited to this repository; absent in `analyze`. */
  readonly gh?: GitHub;
  /** The workflow's own token (actions: read), for the gate's runs and artifacts. */
  readonly actions?: GitHub;
  readonly who: Identities;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  readonly log: Logger;
  /** A directory both phases share through the workflow's artifact. */
  readonly workdir: string;
  /** `talos.yml` as it is at a commit, read through the API. */
  config(ref: string): Promise<TalosConfig>;
};

export type JobOutcome = {
  readonly job: string;
  readonly result: 'done' | 'skipped' | 'failed';
  /** One short line; never repository content. */
  readonly detail: string;
};
