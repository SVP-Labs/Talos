import { fixesFor } from './advisories.js';
import { expired, hoursBetween, youngerThanADay } from './dates.js';
import { hasLockfile, type SupplyDeps } from './deps.js';
import { inPool, type Lookup } from './fetcher.js';
import { type Judged, judgedLockfiles } from './judged.js';
import { isPublic, type Locked, spec } from './lockfiles/index.js';
import { publishedAt } from './registries.js';
import type { TalosConfig } from '../../config/schema.js';
import type { Check } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

type Young = { readonly locked: Locked; readonly published: Date };

function allowed(config: TalosConfig, locked: Locked, now: Date): boolean {
  const entry = config.supply_chain.allow[spec(locked)];
  return entry !== undefined && !expired(entry, now);
}

/** The fast lane: the young release is the fixed version of an advisory against one it replaces. */
async function fixesAnAdvisory(lookup: Lookup, file: Judged, locked: Locked): Promise<boolean> {
  const replaced = file.replaced.get(locked.name) ?? [];
  const fixes = await fixesFor(lookup, locked.ecosystem, locked.name, replaced);
  return fixes.has(locked.version) || fixes.has(locked.version.replace(/^v/, ''));
}

function finding(file: Judged, young: Young, now: Date): Finding {
  const hours = hoursBetween(young.published, now);
  return {
    rule: 'supply/young-release',
    key: spec(young.locked),
    message:
      `${spec(young.locked)} in ${file.path} was published ${hours} hours ago; a release must be a ` +
      'day old unless it fixes an advisory against the version it replaces or ' +
      'supply_chain.allow lists it.',
  };
}

async function youngIn(file: Judged, lookup: Lookup, deps: SupplyDeps, config: TalosConfig) {
  const now = deps.now();
  const dated = await inPool(file.judged.filter(isPublic), 8, async (locked) => ({
    locked,
    published: await publishedAt(lookup, locked),
  }));
  const young = dated.filter(
    (entry): entry is Young =>
      entry.published !== undefined && youngerThanADay(entry.published, now),
  );
  const findings: Finding[] = [];
  for (const entry of young.filter((y) => !allowed(config, y.locked, now))) {
    if (!(await fixesAnAdvisory(lookup, file, entry.locked))) {
      findings.push(finding(file, entry, now));
    }
  }
  return findings;
}

/**
 * Every locked version a public registry published at least a day before the check runs. In a
 * comparison only the versions the change adds are judged, so a release that was young when it
 * landed is never held against a later change.
 */
export function releaseAgeCheck(deps: SupplyDeps): Check {
  return {
    id: 'supply/release-age',
    tier: 'head',
    scope: 'repo',
    title: 'every locked release at least a day old, or a fix for an advisory',
    applies: hasLockfile,
    run: async (ctx) => {
      const lookup = { fetcher: deps.fetcher, memo: ctx.memo };
      const files = await judgedLockfiles(ctx);
      const found = await Promise.all(files.map((file) => youngIn(file, lookup, deps, ctx.config)));
      return found.flat();
    },
  };
}
