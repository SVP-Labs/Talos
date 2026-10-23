import semver from 'semver';

/**
 * Which release each channel's org ruleset pins, decided from the Talos repository's tags, its
 * trusted `regression` issues and the gate runs canary repositories had. Pure: the effects live
 * in `channels-github.ts`.
 */

export const CHANNELS = ['evaluate', 'canary', 'stable'] as const;
export type Channel = (typeof CHANNELS)[number];

export type Release = {
  readonly tag: string;
  readonly version: string;
  readonly sha: string;
  /** When the tag was made: an annotated tag's own date, else its commit's. */
  readonly taggedAt: string;
};

/** The commit each channel's ruleset pins; `undefined` where it pins none yet. */
export type Pins = Readonly<Record<Channel, string | undefined>>;

export type Move = {
  readonly channel: Channel;
  readonly from: string | undefined;
  readonly to: Release;
};

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

/** Plain `vX.Y.Z` tags are releases; prereleases and other tags are not. Newest first. */
export function releasesOf(
  tags: readonly { readonly name: string; readonly sha: string; readonly taggedAt: string }[],
): Release[] {
  return tags
    .flatMap((tag) => {
      const version = RELEASE_TAG.exec(tag.name)?.[1];
      return version === undefined || semver.valid(version) === null
        ? []
        : [{ tag: tag.name, version, sha: tag.sha, taggedAt: tag.taggedAt }];
    })
    .sort((a, b) => semver.compare(b.version, a.version));
}

export function releaseAt(
  releases: readonly Release[],
  sha: string | undefined,
): Release | undefined {
  return sha === undefined ? undefined : releases.find((release) => release.sha === sha);
}

export const REGRESSION_LABEL = 'regression';

/** A `regression` issue on the Talos repository that counts, for rollback and promotion alike. */
export type Regression = {
  readonly number: number;
  readonly open: boolean;
  /** Closed as not planned: a false alarm, which holds nothing back any more. */
  readonly dismissed: boolean;
  /** When it first counted: when a trusted hand put the label on, or opened it labelled. */
  readonly reportedAt: string;
};

export type RegressionIssue = {
  readonly number: number;
  readonly author: string | undefined;
  readonly open: boolean;
  readonly stateReason: string | undefined;
  readonly labels: readonly string[];
  readonly createdAt: string;
  /** The issue's `labeled` events: which label, who put it on, and when. */
  readonly labelled: readonly {
    readonly label: string;
    readonly actor: string | undefined;
    readonly at: string;
  }[];
};

function lower(login: string | undefined): string {
  return (login ?? '').toLowerCase();
}

/**
 * An issue counts when it carries the label and either a trusted actor opened it or a trusted
 * actor put the label on. Logins compare without case, as GitHub's do.
 */
export function regressionOf(
  issue: RegressionIssue,
  trusted: readonly string[],
): Regression | undefined {
  if (!issue.labels.includes(REGRESSION_LABEL)) return undefined;
  const isTrusted = (login: string | undefined): boolean =>
    trusted.some((t) => lower(t) === lower(login) && login !== undefined);
  const byAuthor = isTrusted(issue.author);
  const times = issue.labelled
    .filter((e) => e.label === REGRESSION_LABEL && (byAuthor || isTrusted(e.actor)))
    .map((e) => e.at)
    .sort((a, b) => a.localeCompare(b));
  const reportedAt = times[0] ?? (byAuthor ? issue.createdAt : undefined);
  if (reportedAt === undefined) return undefined;
  return {
    number: issue.number,
    open: issue.open,
    dismissed: !issue.open && issue.stateReason === 'not_planned',
    reportedAt,
  };
}

/**
 * The releases trusted regression reports hold back: for each report not dismissed, the newest
 * release that existed when it was made. Holding them back rather than remembering a rollback
 * keeps the decision stateless: the hourly run would otherwise move canary straight back to the
 * newest tag, and closing the report when the fix merges, before its release is tagged, would do
 * the same.
 */
export function heldBack(
  releases: readonly Release[],
  regressions: readonly Regression[],
): Set<string> {
  const held = new Set<string>();
  for (const regression of regressions) {
    if (regression.dismissed) continue;
    const reported = Date.parse(regression.reportedAt);
    const culprit = releases.find((release) => Date.parse(release.taggedAt) <= reported);
    if (culprit !== undefined) held.add(culprit.tag);
  }
  return held;
}

/**
 * Canary's release: the newest one no regression report holds back. `releases` holds only tags
 * whose commit is an ancestor of `main`, newest first.
 */
export function canaryTarget(
  releases: readonly Release[],
  regressions: readonly Regression[],
): Release | undefined {
  const held = heldBack(releases, regressions);
  return releases.find((release) => !held.has(release.tag));
}

/**
 * The moves that need no gate run to decide: canary to its target, a channel that pins nothing
 * yet seeded (the first release seeds every pin), and evaluate following stable.
 */
export function pinMoves(
  pins: Pins,
  releases: readonly Release[],
  regressions: readonly Regression[],
): Move[] {
  const target = canaryTarget(releases, regressions);
  if (target === undefined) return [];
  const moves: Move[] = [];
  if (pins.canary !== target.sha) moves.push({ channel: 'canary', from: pins.canary, to: target });
  const stable = pins.stable === undefined ? target : releaseAt(releases, pins.stable);
  if (pins.stable === undefined) moves.push({ channel: 'stable', from: undefined, to: target });
  if (stable !== undefined && pins.evaluate !== stable.sha) {
    moves.push({ channel: 'evaluate', from: pins.evaluate, to: stable });
  }
  return moves;
}

/** Gate runs on canary repositories under one release, counted by the gate's job names. */
export type GateTally = { readonly runs: number; readonly engineErrors: number };

/** The gate's job names carry the release, so a run is attributed to it without its logs. */
export function gateJobNames(version: string): { verdict: string; engine: string } {
  return { verdict: `verdict (talos ${version})`, engine: `engine (talos ${version})` };
}

export type GateJob = {
  readonly name: string;
  readonly status: string | null;
  readonly conclusion: string | null;
};

/**
 * A gate run counts once its verdict job finished, green or red: findings are normal. An engine
 * error is the engine job failing, which happens only when the verdict could not be reached or
 * reported one.
 */
export function tallyJobs(jobs: readonly GateJob[], version: string): GateTally {
  const names = gateJobNames(version);
  const finished = new Set(['success', 'failure']);
  let runs = 0;
  let engineErrors = 0;
  for (const job of jobs) {
    if (job.name === names.verdict && finished.has(job.conclusion ?? '')) runs += 1;
    if (job.name === names.engine && job.conclusion === 'failure') engineErrors += 1;
  }
  return { runs, engineErrors };
}

const PROMOTION_DAYS = 7;
const PROMOTION_RUNS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

type PromotionHold =
  | 'no-release'
  | 'not-newer'
  | 'regression-open'
  | 'age-unknown'
  | 'too-young'
  | 'tally-unknown'
  | 'engine-error'
  | 'too-few-runs';

export type PromotionInput = {
  readonly canary: Release | undefined;
  readonly stable: Release | undefined;
  readonly regressionOpen: boolean;
  /** The owner's dispatch: promote after one clean gate run, without the week's wait. */
  readonly urgent: boolean;
  readonly now: Date;
  /** When canary's ruleset began pinning the release; not needed on the urgent path. */
  readonly reachedAt?: string | undefined;
  /** Not yet counted: the decision then says whether counting is worth it. */
  readonly tally?: GateTally | undefined;
};

export type Promotion =
  | { readonly promote: true; readonly release: Release }
  | { readonly promote: false; readonly hold: PromotionHold };

function hold(reason: PromotionHold): Promotion {
  return { promote: false, hold: reason };
}

/** What holds a promotion whatever its age and gate runs. */
function releaseHold(input: PromotionInput): PromotionHold | undefined {
  const { canary, stable } = input;
  if (canary === undefined) return 'no-release';
  if (stable !== undefined && semver.lte(canary.version, stable.version)) return 'not-newer';
  return input.regressionOpen ? 'regression-open' : undefined;
}

/** The week's wait, which the urgent path skips. */
function ageHold(input: PromotionInput): PromotionHold | undefined {
  if (input.urgent) return undefined;
  if (input.reachedAt === undefined || Number.isNaN(Date.parse(input.reachedAt))) {
    return 'age-unknown';
  }
  const age = input.now.getTime() - Date.parse(input.reachedAt);
  return age < PROMOTION_DAYS * DAY_MS ? 'too-young' : undefined;
}

/** What holds a promotion before any gate run is counted, or `undefined` when nothing does. */
function cheapHold(input: PromotionInput): PromotionHold | undefined {
  return releaseHold(input) ?? ageHold(input);
}

/**
 * Whether stable (and evaluate with it) moves to canary's release: seven days after it reached
 * canary, with no engine error and at least five gate runs under it, and no trusted regression
 * open; on the owner's urgent dispatch, after one clean gate run. Stable never moves back.
 */
export function promotion(input: PromotionInput): Promotion {
  const early = cheapHold(input);
  if (early !== undefined) return hold(early);
  if (input.canary === undefined) return hold('no-release');
  if (input.tally === undefined) return hold('tally-unknown');
  if (input.tally.engineErrors > 0) return hold('engine-error');
  const needed = input.urgent ? 1 : PROMOTION_RUNS;
  return input.tally.runs < needed
    ? hold('too-few-runs')
    : { promote: true, release: input.canary };
}

/** Whether reading when canary got its release could still lead to a promotion. */
export function worthDating(input: PromotionInput): boolean {
  return !input.urgent && releaseHold(input) === undefined;
}

/** Whether counting gate runs could still lead to a promotion. */
export function worthCounting(input: PromotionInput): boolean {
  return cheapHold(input) === undefined;
}

/** Stable's move and evaluate's with it. */
export function promotionMoves(pins: Pins, release: Release): Move[] {
  return (['stable', 'evaluate'] as const)
    .filter((channel) => pins[channel] !== release.sha)
    .map((channel) => ({ channel, from: pins[channel], to: release }));
}

/**
 * When canary's ruleset began pinning `sha`: the oldest of the newest unbroken run of ruleset
 * versions that pin it. `versions` is newest first, as GitHub lists a ruleset's history.
 */
export function reachedAt(
  versions: readonly { readonly at: string; readonly sha: string | undefined }[],
  sha: string,
): string | undefined {
  let at: string | undefined;
  for (const version of versions) {
    if (version.sha !== sha) break;
    at = version.at;
  }
  return at;
}

/** Only the owner may dispatch the urgent promotion, and only the owner may rerun one. */
export function dispatchAllowed(
  actors: { readonly actor: string | undefined; readonly triggering: string | undefined },
  owner: string,
): boolean {
  const isOwner = (login: string | undefined): boolean =>
    login !== undefined && lower(login) === lower(owner);
  return isOwner(actors.actor) && (actors.triggering === undefined || isOwner(actors.triggering));
}

/** The pins after the moves, in the order they apply. */
export function afterMoves(pins: Pins, moves: readonly Move[]): Pins {
  const next: Record<Channel, string | undefined> = { ...pins };
  for (const move of moves) next[move.channel] = move.to.sha;
  return next;
}
