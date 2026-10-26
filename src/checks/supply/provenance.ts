import { posix } from 'node:path';
import type { SupplyDeps } from './deps.js';
import { inPool, type Lookup } from './fetcher.js';
import { type Judged, judgedLockfiles } from './judged.js';
import { isPublic, type Locked, spec } from './lockfiles/index.js';
import { enforcesTrust, pnpmSettingsAt } from './pnpm-settings.js';
import { type NpmPackage, npmPackage, type Trust } from './registries.js';
import { APPLIES, type Check, type CheckContext, skip } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

const NPM_LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
]);

const TRUST: Readonly<Record<Trust, string>> = {
  0: 'neither provenance nor a trusted publisher',
  1: 'a provenance attestation',
  2: 'a trusted publisher',
};

/** The most trust any release of the package published before `version` had. */
export function earlierTrust(found: NpmPackage, version: string): Trust {
  const published = found.published.get(version);
  if (published === undefined) return 0;
  let most: Trust = 0;
  for (const [other, when] of found.published) {
    const trust = found.trust.get(other) ?? 0;
    if (when.getTime() < published.getTime() && trust > most) most = trust;
  }
  return most;
}

async function downgrade(lookup: Lookup, path: string, locked: Locked): Promise<Finding[]> {
  const found = await npmPackage(lookup, locked.name);
  if (found?.published.get(locked.version) === undefined) return [];
  const own = found.trust.get(locked.version) ?? 0;
  const before = earlierTrust(found, locked.version);
  if (own >= before) return [];
  return [
    {
      rule: 'supply/provenance-downgrade',
      key: spec(locked),
      message:
        `${spec(locked)} in ${path} was published with ${TRUST[own]}, though an earlier release ` +
        `of ${locked.name} had ${TRUST[before]}; a hijacked release often shows this way.`,
    },
  ];
}

async function judgedHere(ctx: CheckContext): Promise<Judged[]> {
  const files = (await judgedLockfiles(ctx)).filter((f) =>
    NPM_LOCKFILES.has(posix.basename(f.path)),
  );
  const kept = await Promise.all(
    files.map(async (file) => {
      if (posix.basename(file.path) !== 'pnpm-lock.yaml') return true;
      return !enforcesTrust(await pnpmSettingsAt(ctx.root, file.path));
    }),
  );
  return files.filter((_, index) => kept[index] === true);
}

/**
 * npm versions published with less provenance than an earlier release of the same package had,
 * where the package manager doesn't refuse them itself (pnpm's `trustPolicy: no-downgrade` does).
 */
export function provenanceCheck(deps: SupplyDeps): Check {
  return {
    id: 'supply/provenance',
    tier: 'head',
    scope: 'repo',
    title: 'no npm release with weaker provenance than the releases before it',
    applies: (ctx) =>
      ctx.facts.has(...[...NPM_LOCKFILES].map((name) => `**/${name}`))
        ? APPLIES
        : skip('the repository has no npm lockfile'),
    run: async (ctx) => {
      const lookup = { fetcher: deps.fetcher, memo: ctx.memo };
      const files = await judgedHere(ctx);
      const found = await Promise.all(
        files.map(async (file) => {
          const npm = file.judged.filter((l) => l.ecosystem === 'npm' && isPublic(l));
          return (await inPool(npm, 8, (locked) => downgrade(lookup, file.path, locked))).flat();
        }),
      );
      return found.flat();
    },
  };
}
