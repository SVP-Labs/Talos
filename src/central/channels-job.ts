import { readChannelsFile, writeChannelsFile } from './channels-file.js';
import {
  afterMoves,
  type Channel,
  CHANNELS,
  type GateTally,
  type Move,
  type Pins,
  pinMoves,
  type Promotion,
  promotion,
  type PromotionInput,
  promotionMoves,
  reachedAt,
  type Regression,
  type Release,
  releaseAt,
  worthCounting,
  worthDating,
} from './channels.js';
import { canaryRepositories, tallyGateRuns } from './gate-runs.js';
import {
  type ChannelRulesets,
  movePin,
  pinHistory,
  pinsOf,
  readChannelRulesets,
} from './org-rulesets.js';
import { readRegressions, readReleases, releasesOnBranch } from './releases.js';
import type { GitHub } from '../github/api.js';
import type { Identities } from '../github/identities.js';
import { getRepository } from '../github/repos.js';

export type ChannelsDeps = {
  /** The workflow's token on the Talos repository: tags, `main`, issues and `channels.json`. */
  readonly talos: GitHub;
  /** `talos-release` with organisation permissions only: the channel rulesets. */
  readonly release: GitHub;
  /** `talos-release` limited to the canary repositories, actions read; none when there are none. */
  readonly canary: GitHub | undefined;
  /**
   * `talos-release` limited to the Talos repository, contents write, in the `channels` lookup,
   * where `channels.json` mirrors the rulesets; none in the default lookup.
   */
  readonly mirror: GitHub | undefined;
  readonly who: Identities;
  readonly now: Date;
  /** The owner's dispatch. */
  readonly urgent: boolean;
};

export type ChannelsReport = {
  /** Each channel's release after the run; Talos's tags are public. */
  readonly pins: Readonly<Record<Channel, string | null>>;
  readonly moved: number;
  /** `canary-moved`: a release just reached canary, so nothing is promoted in the same run. */
  readonly promotion: 'promoted' | 'canary-moved' | Exclude<Promotion, { promote: true }>['hold'];
  readonly regressions: number;
  readonly gateRuns: number | null;
  readonly engineErrors: number | null;
  /** Channels without a ruleset to move. */
  readonly missing: number;
};

type Known = {
  readonly talosId: number;
  readonly releases: readonly Release[];
  readonly onMain: readonly Release[];
  readonly regressions: readonly Regression[];
  readonly rulesets: ChannelRulesets;
  readonly pins: Pins;
};

async function readState(deps: ChannelsDeps): Promise<Known> {
  const repo = deps.who.talosRepo;
  const trusted = [deps.who.owner, deps.who.thea, deps.who.reviewer, deps.who.release];
  const [talos, releases, regressions, rulesets] = await Promise.all([
    getRepository(deps.talos, repo),
    readReleases(deps.talos, repo),
    readRegressions(deps.talos, repo, trusted),
    readChannelRulesets(deps.release, deps.who.org),
  ]);
  const onMain = await releasesOnBranch(deps.talos, repo, releases, talos.defaultBranch);
  return {
    talosId: talos.id,
    releases,
    onMain,
    regressions,
    rulesets,
    pins: pinsOf(rulesets, talos.id),
  };
}

/** The last move per channel, in the order rulesets are moved: canary, stable, evaluate. */
export function mergeMoves(moves: readonly Move[]): Move[] {
  const order: readonly Channel[] = ['canary', 'stable', 'evaluate'];
  return order.flatMap((channel) => {
    const last = moves.filter((move) => move.channel === channel).at(-1);
    return last === undefined ? [] : [last];
  });
}

type Judged = { readonly promotion: Promotion; readonly tally: GateTally | undefined };

/** The gate runs under canary's release; with no canary repository there are none. */
async function canaryTally(gh: GitHub | undefined, canary: Release): Promise<GateTally> {
  if (gh === undefined) return { runs: 0, engineErrors: 0 };
  const repos = await canaryRepositories(gh);
  return tallyGateRuns(gh, repos, canary.version, canary.taggedAt);
}

async function judgePromotion(deps: ChannelsDeps, known: Known): Promise<Judged> {
  const canary = releaseAt(known.releases, known.pins.canary);
  const base: PromotionInput = {
    canary,
    stable: releaseAt(known.releases, known.pins.stable),
    regressionOpen: known.regressions.some((r) => r.open),
    urgent: deps.urgent,
    now: deps.now,
  };
  const ruleset = known.rulesets.canary;
  let input = base;
  if (canary !== undefined && ruleset !== undefined && worthDating(base)) {
    const at = { org: deps.who.org, talosId: known.talosId };
    const history = await pinHistory(deps.release, at, ruleset.id, canary.sha);
    input = { ...base, reachedAt: reachedAt(history, canary.sha) };
  }
  if (canary === undefined || !worthCounting(input)) {
    return { promotion: promotion(input), tally: undefined };
  }
  const tally = await canaryTally(deps.canary, canary);
  return { promotion: promotion({ ...input, tally }), tally };
}

async function applyMoves(
  deps: ChannelsDeps,
  known: Known,
  moves: readonly Move[],
): Promise<Move[]> {
  const applied: Move[] = [];
  for (const move of moves) {
    const ruleset = known.rulesets[move.channel];
    if (ruleset === undefined) continue;
    await movePin(
      deps.release,
      { org: deps.who.org, talosId: known.talosId },
      ruleset,
      move.to.sha,
    );
    applied.push(move);
  }
  return applied;
}

function outcomeOf(judged: Judged | undefined): ChannelsReport['promotion'] {
  if (judged === undefined) return 'canary-moved';
  return judged.promotion.promote ? 'promoted' : judged.promotion.hold;
}

function tagsOf(releases: readonly Release[], pins: Pins): ChannelsReport['pins'] {
  const tag = (channel: Channel): string | null => releaseAt(releases, pins[channel])?.tag ?? null;
  return { evaluate: tag('evaluate'), canary: tag('canary'), stable: tag('stable') };
}

/**
 * One run of the channel job: seed missing pins, move canary to the newest release no trusted
 * regression holds back, promote canary's release to stable when it has earned it, keep evaluate
 * on stable's pin, and mirror the result to `channels.json` when that lookup is in use.
 */
export async function runChannels(deps: ChannelsDeps): Promise<ChannelsReport> {
  const known = await readState(deps);
  const early = pinMoves(known.pins, known.onMain, known.regressions);
  const canaryMoves = early.some((move) => move.channel === 'canary');
  const judged = canaryMoves ? undefined : await judgePromotion(deps, known);
  const promotions =
    judged?.promotion.promote === true
      ? promotionMoves(afterMoves(known.pins, early), judged.promotion.release)
      : [];
  const applied = await applyMoves(deps, known, mergeMoves([...early, ...promotions]));
  const pins = afterMoves(known.pins, applied);
  if (deps.mirror !== undefined) {
    const file = await readChannelsFile(deps.talos, deps.who.talosRepo);
    await writeChannelsFile(deps.mirror, deps.who.talosRepo, pins, file);
  }
  return {
    pins: tagsOf(known.releases, pins),
    moved: applied.length,
    promotion: outcomeOf(judged),
    regressions: known.regressions.filter((r) => r.open).length,
    gateRuns: judged?.tally?.runs ?? null,
    engineErrors: judged?.tally?.engineErrors ?? null,
    missing: CHANNELS.filter((channel) => known.rulesets[channel] === undefined).length,
  };
}
