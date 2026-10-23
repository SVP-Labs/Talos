import type { Declaration } from './declaration.js';
import type { Cycle, Feeds, RuntimeFeed } from './feeds.js';
import { RUNTIMES } from './runtimes.js';
import { compareVersions, cycleOf, inCycle, leadingRelease, newest } from './versions.js';
import { EngineError } from '../../core/check.js';
import type { Finding, Location } from '../../core/finding.js';

export const SECURITY_RULE = 'runtime/security';
const EOL_RULE = 'runtime/eol';
const UNPINNED_RULE = 'runtime/unpinned';

const MAX_WRITTEN = 80;

function shown(declaration: Declaration): string {
  const { written } = declaration;
  return written.length > MAX_WRITTEN ? `${written.slice(0, MAX_WRITTEN - 1)}…` : written;
}

/** The declaration as written, in parentheses, unless it says no more than its version. */
function aside(declaration: Declaration): string {
  return declaration.written === declaration.version ? '' : ` (${shown(declaration)})`;
}

function locationOf(declaration: Declaration): Location {
  const { file, line, endLine } = declaration;
  return { file, line, ...(endLine !== undefined && endLine > line ? { endLine } : {}) };
}

function docsOf(declaration: Declaration): string {
  return `https://endoflife.date/${RUNTIMES[declaration.runtime].product}`;
}

function isPast(cycle: Cycle, today: string): boolean {
  return cycle.isEol || (cycle.eol !== undefined && cycle.eol <= today);
}

/** The newest cycle still supported, to suggest instead of one past its end of life. */
function supported(feed: RuntimeFeed, today: string): Cycle | undefined {
  const live = feed.cycles.filter((cycle) => !isPast(cycle, today));
  const name = newest(live.map((cycle) => cycle.name));
  return live.find((cycle) => cycle.name === name);
}

function cycleFor(declaration: Declaration, feed: RuntimeFeed): Cycle | undefined {
  const release = leadingRelease(declaration.version ?? '');
  if (release === undefined) return undefined;
  const name = cycleOf(
    release,
    feed.cycles.map((cycle) => cycle.name),
  );
  return feed.cycles.find((cycle) => cycle.name === name);
}

/** The cycle's releases after `version` that are security releases. */
function securityAfter(
  declaration: Declaration,
  feed: RuntimeFeed,
  cycle: Cycle,
  version: string,
): string[] {
  const source = RUNTIMES[declaration.runtime].security;
  if (source === 'none') return [];
  if (source === 'phase') {
    const { latest, latestDate, activeUntil } = cycle;
    const inPhase =
      latest !== undefined && latestDate !== undefined && activeUntil !== undefined
        ? latestDate >= activeUntil
        : false;
    return inPhase && latest !== undefined && compareVersions(latest, version) > 0 ? [latest] : [];
  }
  if (feed.security === undefined) {
    throw new EngineError(`no security feed was loaded for ${declaration.runtime}`);
  }
  return [...feed.security].filter(
    (release) => inCycle(release, cycle.name) && compareVersions(release, version) > 0,
  );
}

/** One declaration, the feed of its runtime, its cycle there, and the day it is judged on. */
type Judging = {
  readonly declaration: Declaration;
  readonly feed: RuntimeFeed;
  readonly cycle: Cycle | undefined;
  readonly today: string;
};

function securityFinding({ declaration, feed, cycle }: Judging): Finding[] {
  const { version } = declaration;
  if (declaration.exactness !== 'exact' || version === undefined || cycle === undefined) return [];
  const releases = securityAfter(declaration, feed, cycle, version);
  const fixed = newest(releases);
  if (fixed === undefined) return [];
  const target = newest([fixed, cycle.latest ?? fixed]) ?? fixed;
  const label = RUNTIMES[declaration.runtime].label;
  const advice =
    target === fixed
      ? `move to ${target} or later`
      : `move to ${target}, the cycle's newest (${fixed} is its newest security release)`;
  return [
    {
      rule: SECURITY_RULE,
      message: `${label} ${version}${aside(declaration)} is behind a security release of its cycle; ${advice}.`,
      location: locationOf(declaration),
      key: `${declaration.runtime} ${version}`,
      policy: 'always',
      docs: docsOf(declaration),
    },
  ];
}

function eolMessage(declaration: Declaration, cycle: Cycle, instead: Cycle | undefined): string {
  const label = RUNTIMES[declaration.runtime].label;
  const when =
    cycle.eol === undefined ? 'is past its end of life' : `reached its end of life on ${cycle.eol}`;
  const suggestion =
    instead === undefined ? 'a supported cycle' : `a supported cycle such as ${instead.name}`;
  if (declaration.exactness === 'minimum') {
    return `${declaration.file} resolves dependencies for ${label} ${cycle.name}, which ${when}; raise config.platform.php to ${suggestion}.`;
  }
  return `${label} ${cycle.name}${aside(declaration)} ${when} and gets no more security releases; move to ${suggestion}.`;
}

function eolFinding({ declaration, feed, cycle, today }: Judging): Finding[] {
  if (cycle === undefined || !isPast(cycle, today)) return [];
  return [
    {
      rule: EOL_RULE,
      message: eolMessage(declaration, cycle, supported(feed, today)),
      location: locationOf(declaration),
      docs: docsOf(declaration),
    },
  ];
}

/** The release to suggest: its own cycle's newest while supported, else the newest supported. */
function example({ feed, cycle, today }: Judging): string | undefined {
  const own = cycle !== undefined && !isPast(cycle, today) ? cycle.latest : undefined;
  return own ?? supported(feed, today)?.latest;
}

function unpinnedFinding(judging: Judging): Finding[] {
  const { declaration } = judging;
  if (declaration.exactness !== 'floating') return [];
  const label = RUNTIMES[declaration.runtime].label;
  const release = example(judging);
  const pin =
    release === undefined ? 'pin an exact release' : `pin an exact release, such as ${release}`;
  return [
    {
      rule: UNPINNED_RULE,
      message: `${shown(declaration)} in ${declaration.file} pins no exact ${label} release, so it can't be checked for security releases; ${pin}.`,
      location: locationOf(declaration),
      docs: docsOf(declaration),
    },
  ];
}

/**
 * The findings for each declaration, judged against the feeds on `today` (`YYYY-MM-DD`):
 * - `runtime/security` (`always`): an exact release with a newer security release in its cycle;
 * - `runtime/eol`: a cycle past its end of life, for pins and minimums alike;
 * - `runtime/unpinned`: no exact release pinned.
 * A minimum (composer.json's platform PHP) is never a security finding: it isn't what ships.
 */
export function assessRuntimes(
  declarations: readonly Declaration[],
  feeds: Feeds,
  today: string,
): Finding[] {
  return declarations.flatMap((declaration) => {
    const feed = feeds.get(declaration.runtime);
    if (feed === undefined) {
      throw new EngineError(`no release feed was loaded for ${declaration.runtime}`);
    }
    const judging: Judging = { declaration, feed, cycle: cycleFor(declaration, feed), today };
    return [...securityFinding(judging), ...eolFinding(judging), ...unpinnedFinding(judging)];
  });
}
