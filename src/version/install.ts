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
const NPM_CACHE = 'npm-cache';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/;
const ERROR_CODE = /^E[A-Z0-9_]+$/;
/** How many packages of one kind a failed audit names. */
const NAMED = 20;

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
  /** Writes one line of what the install did, such as the packages a failed audit names. */
  readonly log: (line: string) => void;
};

/** How one `npm audit signatures --json` ended. */
type AuditRun = { readonly code: number; readonly stdout: string };

const markerSchema = z.object({ version: z.string(), sha: z.string(), integrity: z.string() });

const lockSchema = z.object({
  packages: z.record(
    z.string(),
    z.object({ version: z.string(), integrity: z.string() }).partial(),
  ),
});

const auditSchema = z.object({ invalid: z.array(z.unknown()), missing: z.array(z.unknown()) });

const auditedNameSchema = z.object({
  name: z.string().regex(PACKAGE_NAME),
  version: z.string().regex(VERSION),
});

const auditedCodeSchema = z.object({ code: z.string().regex(ERROR_CODE) });

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

/** A list in an audit report, or undefined when the report or the list is not there. */
function reported(stdout: string, key: 'invalid' | 'missing'): readonly unknown[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const parsed = z.object({ [key]: z.array(z.unknown()) }).safeParse(raw);
  return parsed.success ? parsed.data[key] : undefined;
}

/** A package an audit objects to, as `name@version (code)`, with only what has npm's shape. */
function auditedPackage(entry: unknown): string {
  const named = auditedNameSchema.safeParse(entry);
  const coded = auditedCodeSchema.safeParse(entry);
  const shown = named.success
    ? `${named.data.name}@${named.data.version}`
    : 'a package npm did not name';
  return coded.success ? `${shown} (${coded.data.code})` : shown;
}

/** One line per package an audit objects to, at most `NAMED` of each kind. */
function auditFailures(stdout: string): string[] {
  const lines: string[] = [];
  for (const kind of ['invalid', 'missing'] as const) {
    const entries = reported(stdout, kind) ?? [];
    const named = entries.slice(0, NAMED).map(auditedPackage);
    const rest = entries.length - named.length;
    const shown = rest > 0 ? [...named, `${rest} more`] : named;
    lines.push(...shown.map((text) => `npm audit signatures: ${kind}: ${text}`));
  }
  return lines;
}

/**
 * What `npm audit signatures` objects to, after a second audit when the first found invalid
 * signatures and nothing else; empty when every signature verified. Logs each package a failed
 * audit objects to, and the second audit. npm verifies many packages at a time, and on a cold
 * cache one check can read sigstore's trusted root while another writes it, which fails as an
 * invalid signature; with the cache warm, only a signature that is really bad fails again.
 */
export async function auditSignatures(
  audit: () => Promise<AuditRun>,
  log: (line: string) => void,
): Promise<string[]> {
  const first = await audit();
  const problems = auditProblems(first.code, first.stdout);
  if (problems.length === 0) return problems;
  for (const line of auditFailures(first.stdout)) log(line);
  const onlyInvalid =
    (reported(first.stdout, 'invalid')?.length ?? 0) > 0 &&
    reported(first.stdout, 'missing')?.length === 0;
  if (!onlyInvalid) return problems;
  log('npm audit signatures found invalid signatures only: auditing once more');
  const second = await audit();
  const again = auditProblems(second.code, second.stdout);
  if (again.length > 0) for (const line of auditFailures(second.stdout)) log(line);
  return again;
}

/** npm's arguments for a run in `directory`, with a cache of that run's own inside it. */
export function npmArguments(args: readonly string[], directory: string): string[] {
  return [...args, '--cache', join(directory, NPM_CACHE)];
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
  const result = await exec('npm', npmArguments(args, cwd), { cwd, timeoutMs: NPM_TIMEOUT });
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
  const problems = await auditSignatures(
    () =>
      deps.exec('npm', npmArguments(['audit', 'signatures', '--json'], staging), {
        cwd: staging,
        timeoutMs: NPM_TIMEOUT,
      }),
    deps.log,
  );
  if (problems.length > 0) throw new VersionError(`refusing ${spec}: ${problems.join('; ')}`);
  await rm(join(staging, NPM_CACHE), { recursive: true, force: true });
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
