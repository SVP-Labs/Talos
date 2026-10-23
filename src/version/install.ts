import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { cacheRoot } from './cache.js';
import { VersionError } from './errors.js';
import { decodeProvenance, PACKAGE, provenanceProblems } from './provenance.js';
import type { Release } from './release.js';
import type { Exec } from '../exec/exec.js';

export const MARKER = 'talos-verified.json';
const SOURCE = 'SVP-Labs/Talos';
const REGISTRY = 'https://registry.npmjs.org';
const NPM_TIMEOUT = 10 * 60 * 1000;

export type Installed = Release & {
  /** The cache entry: a directory holding `node_modules/@svp-labs/talos` and the marker. */
  readonly root: string;
  /** The entry point to run with `node`. */
  readonly bin: string;
  readonly integrity: string;
};

export type InstallDeps = {
  readonly exec: Exec;
  readonly fetch: typeof fetch;
  readonly env: Readonly<Record<string, string | undefined>>;
};

const markerSchema = z.object({ version: z.string(), sha: z.string(), integrity: z.string() });

const lockSchema = z.object({
  packages: z.record(
    z.string(),
    z.object({ version: z.string(), integrity: z.string() }).partial(),
  ),
});

const auditSchema = z.object({ invalid: z.array(z.unknown()), missing: z.array(z.unknown()) });

export function entryFor(cache: string, release: Release): string {
  return join(cache, 'engine', `${release.version}-${release.sha.slice(0, 12)}`);
}

export function binIn(root: string): string {
  return join(root, 'node_modules', '@svp-labs', 'talos', 'dist', 'bin', 'talos.js');
}

/** The integrity npm recorded for the installed package, when it is the expected version. */
export function lockedIntegrity(lock: unknown, version: string): string | undefined {
  const parsed = lockSchema.safeParse(lock);
  if (!parsed.success) return undefined;
  const entry = parsed.data.packages[`node_modules/${PACKAGE}`];
  return entry?.version === version ? entry.integrity : undefined;
}

/** What `npm audit signatures --json` objects to; empty when every signature verified. */
export function auditProblems(code: number, stdout: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [`npm audit signatures exited ${code} without a readable report`];
  }
  const parsed = auditSchema.safeParse(raw);
  if (!parsed.success) return [`npm audit signatures exited ${code} without a readable report`];
  const problems = [
    ...(parsed.data.invalid.length > 0 ? [`${parsed.data.invalid.length} invalid signatures`] : []),
    ...(parsed.data.missing.length > 0 ? [`${parsed.data.missing.length} missing signatures`] : []),
  ];
  return problems.length === 0 && code !== 0 ? [`npm audit signatures exited ${code}`] : problems;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A cache entry verified earlier for this release, still as it was. */
async function verifiedEntry(root: string, release: Release): Promise<Installed | undefined> {
  const marker = markerSchema.safeParse(await readJson(join(root, MARKER)));
  if (!marker.success) return undefined;
  const { version, sha, integrity } = marker.data;
  if (version !== release.version || sha !== release.sha) return undefined;
  const locked = lockedIntegrity(await readJson(join(root, 'package-lock.json')), version);
  const bin = binIn(root);
  if (locked !== integrity || !(await exists(bin))) return undefined;
  return { version, sha, integrity, root, bin };
}

async function npm(exec: Exec, args: readonly string[], cwd: string): Promise<void> {
  const result = await exec('npm', args, { cwd, timeoutMs: NPM_TIMEOUT });
  if (result.code !== 0) {
    throw new VersionError(`npm ${args[0] ?? ''} for ${PACKAGE} exited ${result.code}`);
  }
}

async function verifyProvenance(
  release: Release,
  integrity: string,
  doFetch: typeof fetch,
): Promise<void> {
  const url = `${REGISTRY}/-/npm/v1/attestations/${encodeURIComponent(PACKAGE)}@${release.version}`;
  const response = await doFetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new VersionError(`${PACKAGE}@${release.version} has no provenance on the npm registry`);
  }
  const problems = provenanceProblems(decodeProvenance(await response.json()), {
    name: PACKAGE,
    version: release.version,
    repository: SOURCE,
    commit: release.sha,
    integrity,
  });
  if (problems.length > 0) {
    throw new VersionError(`refusing ${PACKAGE}@${release.version}: ${problems.join('; ')}`);
  }
}

async function installInto(staging: string, release: Release, deps: InstallDeps): Promise<string> {
  await writeFile(join(staging, 'package.json'), '{ "private": true }\n');
  const spec = `${PACKAGE}@${release.version}`;
  await npm(
    deps.exec,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', spec],
    staging,
  );
  const integrity = lockedIntegrity(
    await readJson(join(staging, 'package-lock.json')),
    release.version,
  );
  if (integrity === undefined) throw new VersionError(`npm installed no ${spec}`);
  const audit = await deps.exec('npm', ['audit', 'signatures', '--json'], {
    cwd: staging,
    timeoutMs: NPM_TIMEOUT,
  });
  const problems = auditProblems(audit.code, audit.stdout);
  if (problems.length > 0) throw new VersionError(`refusing ${spec}: ${problems.join('; ')}`);
  await verifyProvenance(release, integrity, deps.fetch);
  return integrity;
}

/**
 * The release installed in Talos's cache and verified: npm's registry signatures and
 * attestations (`npm audit signatures`), then a provenance naming the Talos repository, the
 * pinned commit and the installed tarball. A verified entry is reused; a new one is built aside
 * and moved into place, so concurrent runs never see half an install.
 */
export async function ensureVerified(release: Release, deps: InstallDeps): Promise<Installed> {
  const root = entryFor(cacheRoot(deps.env), release);
  const cached = await verifiedEntry(root, release);
  if (cached !== undefined) return cached;
  await mkdir(dirname(root), { recursive: true });
  const staging = await mkdtemp(`${root}.staging-`);
  try {
    const integrity = await installInto(staging, release, deps);
    await writeFile(
      join(staging, MARKER),
      `${JSON.stringify({ version: release.version, sha: release.sha, integrity })}\n`,
    );
    // Another run may have settled the same release meanwhile and be running from it.
    if ((await verifiedEntry(root, release)) === undefined) {
      await rm(root, { recursive: true, force: true });
      await rename(staging, root).catch(() => undefined);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const settled = await verifiedEntry(root, release);
  if (settled === undefined) throw new VersionError(`${PACKAGE}@${release.version} did not settle`);
  return settled;
}
