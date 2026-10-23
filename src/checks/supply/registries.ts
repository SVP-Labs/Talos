import { z } from 'zod';
import { getJson, getText, type Lookup } from './fetcher.js';
import type { Ecosystem, Locked } from './lockfiles/index.js';
import { EngineError } from '../../core/check.js';

/**
 * How much a registry vouches for where an npm version was built: 2 for a trusted publisher,
 * 1 for a provenance attestation, 0 for neither, the levels pnpm's `trustPolicy` compares.
 */
export type Trust = 0 | 1 | 2;

export type NpmPackage = {
  readonly published: ReadonlyMap<string, Date>;
  readonly trust: ReadonlyMap<string, Trust>;
};

const packument = z.looseObject({
  time: z.record(z.string(), z.string()).default({}),
  versions: z
    .record(
      z.string(),
      z.looseObject({
        dist: z.looseObject({ attestations: z.looseObject({}).optional() }).optional(),
        _npmUser: z.looseObject({ trustedPublisher: z.unknown().optional() }).optional(),
      }),
    )
    .default({}),
});

function dated(entries: readonly (readonly [string, string | undefined])[]): Map<string, Date> {
  const dates = new Map<string, Date>();
  for (const [version, when] of entries) {
    const date = when === undefined ? undefined : new Date(when);
    if (date !== undefined && !Number.isNaN(date.getTime())) dates.set(version, date);
  }
  return dates;
}

/** An npm package's publish times and trust levels, or `undefined` when npm doesn't know it. */
export async function npmPackage(lookup: Lookup, name: string): Promise<NpmPackage | undefined> {
  return lookup.memo(`supply/npm/${name}`, async () => {
    const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
    const raw = await getJson(lookup.fetcher, { url }, `npm's registry (${name})`);
    if (raw === undefined) return undefined;
    const parsed = packument.parse(raw);
    const trust = new Map<string, Trust>();
    for (const [version, manifest] of Object.entries(parsed.versions)) {
      const level = manifest.dist?.attestations === undefined ? 0 : 1;
      trust.set(version, manifest._npmUser?.trustedPublisher === undefined ? level : 2);
    }
    return { published: dated(Object.entries(parsed.time)), trust };
  });
}

const pypiRelease = z.looseObject({
  urls: z.array(z.looseObject({ upload_time_iso_8601: z.string() })).default([]),
});

async function pypiPublished(lookup: Lookup, name: string, version: string) {
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  const raw = await getJson(lookup.fetcher, { url }, `PyPI (${name})`);
  if (raw === undefined) return undefined;
  const times = pypiRelease.parse(raw).urls.map((file) => new Date(file.upload_time_iso_8601));
  const first = Math.min(...times.map((time) => time.getTime()));
  return Number.isFinite(first) ? new Date(first) : undefined;
}

const packagist = z.looseObject({
  packages: z.record(
    z.string(),
    z.array(z.looseObject({ version: z.string().optional(), time: z.string().optional() })),
  ),
});

/** Packagist's minified metadata leaves out a field that repeats the previous version's. */
async function packagistTimes(lookup: Lookup, name: string): Promise<Map<string, Date>> {
  return lookup.memo(`supply/packagist/${name}`, async () => {
    const url = `https://repo.packagist.org/p2/${name}.json`;
    const raw = await getJson(lookup.fetcher, { url }, `Packagist (${name})`);
    if (raw === undefined) return new Map<string, Date>();
    const entries: [string, string | undefined][] = [];
    let time: string | undefined;
    for (const release of packagist.parse(raw).packages[name] ?? []) {
      time = release.time ?? time;
      if (release.version !== undefined) entries.push([release.version.replace(/^v/, ''), time]);
    }
    return dated(entries);
  });
}

/** The sparse index's path for a crate: `1/a`, `2/ab`, `3/a/abc`, `ab/cd/abcd…`. */
export function crateIndexPath(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower.charAt(0)}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

const crateLine = z.looseObject({ vers: z.string(), pubtime: z.string().optional() });

function crateEntry(line: string): [string, string | undefined] {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new EngineError('the crates.io index answered with a line that is not JSON');
  }
  const entry = crateLine.parse(raw);
  return [entry.vers, entry.pubtime];
}

async function crateTimes(lookup: Lookup, name: string): Promise<Map<string, Date>> {
  return lookup.memo(`supply/crates/${name}`, async () => {
    const url = `https://index.crates.io/${crateIndexPath(name)}`;
    const body = await getText(lookup.fetcher, { url }, `the crates.io index (${name})`);
    const lines = (body ?? '').split('\n').filter((line) => line.trim() !== '');
    return dated(lines.map((line) => crateEntry(line)));
  });
}

const PUBLISHED: Readonly<
  Record<Ecosystem, (lookup: Lookup, name: string, version: string) => Promise<Date | undefined>>
> = {
  npm: async (lookup, name, version) => (await npmPackage(lookup, name))?.published.get(version),
  pypi: pypiPublished,
  packagist: async (lookup, name, version) =>
    (await packagistTimes(lookup, name)).get(version.replace(/^v/, '')),
  crates: async (lookup, name, version) => (await crateTimes(lookup, name)).get(version),
};

/** When the public registry published a locked version; `undefined` when it doesn't know it. */
export async function publishedAt(lookup: Lookup, locked: Locked): Promise<Date | undefined> {
  return PUBLISHED[locked.ecosystem](lookup, locked.name, locked.version);
}
