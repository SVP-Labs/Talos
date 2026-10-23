import { z } from 'zod';
import { getJson, inPool, type Lookup } from './fetcher.js';
import type { Ecosystem } from './lockfiles/index.js';

/** OSV's names for the ecosystems. */
const OSV_ECOSYSTEM: Readonly<Record<Ecosystem, string>> = {
  npm: 'npm',
  pypi: 'PyPI',
  packagist: 'Packagist',
  crates: 'crates.io',
};

const OSV = 'https://api.osv.dev/v1';

const batch = z.looseObject({
  results: z.array(
    z.looseObject({ vulns: z.array(z.looseObject({ id: z.string() })).default([]) }),
  ),
});

const vulnerability = z.looseObject({
  id: z.string(),
  affected: z
    .array(
      z.looseObject({
        package: z.looseObject({ name: z.string(), ecosystem: z.string() }).optional(),
        ranges: z
          .array(
            z.looseObject({
              events: z.array(z.looseObject({ fixed: z.string().optional() })).default([]),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export type Vulnerability = z.infer<typeof vulnerability>;

/** PyPI treats `-`, `_` and `.` alike and ignores case; npm, Packagist and crates.io are exact. */
export function sameName(ecosystem: Ecosystem, a: string, b: string): boolean {
  if (ecosystem !== 'pypi') return a === b;
  const normal = (name: string): string => name.toLowerCase().replaceAll(/[-_.]+/g, '-');
  return normal(a) === normal(b);
}

/** The versions an advisory says fix it, for one package. */
export function fixedVersions(
  advisory: Vulnerability,
  ecosystem: Ecosystem,
  name: string,
): string[] {
  return advisory.affected
    .filter((entry) => entry.package?.ecosystem === OSV_ECOSYSTEM[ecosystem])
    .filter((entry) => sameName(ecosystem, entry.package?.name ?? '', name))
    .flatMap((entry) => entry.ranges.flatMap((range) => range.events))
    .flatMap((event) => (event.fixed === undefined ? [] : [event.fixed]));
}

async function advisory(lookup: Lookup, id: string): Promise<Vulnerability | undefined> {
  return lookup.memo(`supply/osv/${id}`, async () => {
    const url = `${OSV}/vulns/${encodeURIComponent(id)}`;
    const raw = await getJson(lookup.fetcher, { url }, `the OSV API (${id})`);
    return raw === undefined ? undefined : vulnerability.parse(raw);
  });
}

/**
 * Every version that fixes an advisory affecting any of `versions` of a package: one batched
 * query for the advisories, then each advisory once per run.
 */
export async function fixesFor(
  lookup: Lookup,
  ecosystem: Ecosystem,
  name: string,
  versions: readonly string[],
): Promise<Set<string>> {
  if (versions.length === 0) return new Set();
  const queries = versions.map((version) => ({
    package: { name, ecosystem: OSV_ECOSYSTEM[ecosystem] },
    version,
  }));
  const raw = await getJson(
    lookup.fetcher,
    { url: `${OSV}/querybatch`, method: 'POST', body: JSON.stringify({ queries }) },
    `the OSV API (${name})`,
  );
  const results = batch.parse(raw ?? { results: [] }).results;
  const ids = new Set(results.flatMap((result) => result.vulns.map((found) => found.id)));
  const advisories = await inPool([...ids], 8, (id) => advisory(lookup, id));
  return new Set(
    advisories.flatMap((found) =>
      found === undefined ? [] : fixedVersions(found, ecosystem, name),
    ),
  );
}
