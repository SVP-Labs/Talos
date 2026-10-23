import { isPast } from '../../checks/runtime/assess.js';
import { pinned } from '../../checks/runtime/declaration.js';
import { loadFeeds, type RuntimeFeed } from '../../checks/runtime/feeds.js';
import { defaultFetcher, type Fetcher } from '../../checks/runtime/fetchers.js';
import {
  compareVersions,
  cycleOf,
  inCycle,
  isExactRelease,
  newest,
} from '../../checks/runtime/versions.js';
import { EngineError } from '../../core/check.js';
import type { Exec } from '../../exec/exec.js';
import { ExecError } from '../../exec/exec.js';

export type Freshness = {
  readonly fetcher: Fetcher;
  /** `YYYY-MM-DD`, in UTC. */
  readonly today: string;
};

/** Major, minor and release only: a distribution's suffix on `PHP_VERSION` is not a release. */
const VERSION_CODE = 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION, ".", PHP_RELEASE_VERSION;';

/** Why PHP `version` must not run the checks, judged against its runtime feed, or nothing. */
export function staleness(version: string, feed: RuntimeFeed, today: string): string | undefined {
  const name = cycleOf(
    version,
    feed.cycles.map((cycle) => cycle.name),
  );
  const cycle = feed.cycles.find((known) => known.name === name);
  if (cycle === undefined) return `PHP ${version} is no release endoflife.date knows`;
  if (isPast(cycle, today)) {
    return `PHP ${cycle.name} is past its end of life and gets no more security releases`;
  }
  const security = [...(feed.security ?? [])].filter((release) => inCycle(release, cycle.name));
  const latest = newest([version, cycle.latest ?? version, ...security]) ?? version;
  if (compareVersions(latest, version) <= 0) return undefined;
  const fixes = security.some((release) => compareVersions(release, version) > 0)
    ? ', a security release'
    : '';
  return `PHP ${version} is not the newest ${cycle.name} release: ${latest} is${fixes}`;
}

async function runningPhp(exec: Exec, cwd: string): Promise<string> {
  let output: string;
  try {
    const result = await exec('php', ['-r', VERSION_CODE], { cwd });
    if (result.code !== 0) throw new ExecError(result.stderr.trim().slice(0, 200));
    output = result.stdout.trim();
  } catch (error) {
    if (!(error instanceof ExecError)) throw error;
    throw new EngineError(`php is needed on PATH: ${error.message}`);
  }
  if (!isExactRelease(output)) throw new EngineError(`php reported no release: "${output}"`);
  return output;
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Refuses to run a project's code and its checks on any PHP but the newest release of its cycle,
 * per endoflife.date and php.net's security tags.
 */
export async function requireNewestPhp(
  exec: Exec,
  cwd: string,
  freshness: Freshness = { fetcher: defaultFetcher(), today: utcToday() },
): Promise<void> {
  const version = await runningPhp(exec, cwd);
  const declaration = pinned('php', { file: 'PATH', line: 1 }, version, version);
  const feed = (await loadFeeds([declaration], freshness.fetcher)).get('php');
  const problem =
    feed === undefined ? 'no PHP feed loaded' : staleness(version, feed, freshness.today);
  if (problem !== undefined) throw new EngineError(`${problem}; update the PHP on PATH`);
}
