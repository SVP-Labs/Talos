import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { componentDir, type Place } from './paths.js';
import { EngineError } from '../../core/check.js';

const links = z.record(z.string(), z.string()).default({});

const namespaces = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

const autoload = z.object({
  'psr-4': namespaces.optional(),
  'psr-0': namespaces.optional(),
  classmap: z.array(z.string()).optional(),
});

export type Autoload = z.infer<typeof autoload>;

const manifest = z.object({
  require: links,
  'require-dev': links,
  autoload: autoload.optional(),
  'autoload-dev': autoload.optional(),
});

export type Manifest = z.infer<typeof manifest>;

const lockedPackage = z.object({
  name: z.string(),
  version: z.string(),
  autoload: autoload.optional(),
});

const lock = z.object({
  packages: z.array(lockedPackage).default([]),
  'packages-dev': z.array(lockedPackage).default([]),
});

export type Lock = z.infer<typeof lock>;

const installedPackage = z.object({ name: z.string(), version: z.string() });

/** Composer 2 writes an object with `packages`; Composer 1 wrote the bare list. */
const installed = z.union([
  z.object({ packages: z.array(installedPackage) }),
  z.array(installedPackage),
]);

function parse<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new EngineError(`${what} is not valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EngineError(`${what} has a shape Talos cannot read`);
  return parsed.data;
}

export function parseManifest(text: string): Manifest {
  return parse(manifest, text, 'composer.json');
}

export function parseLock(text: string): Lock {
  return parse(lock, text, 'composer.lock');
}

/** Installed versions by package name, without the `v` some tags carry. */
export function parseInstalled(text: string): ReadonlyMap<string, string> {
  const data = parse(installed, text, 'vendor/composer/installed.json');
  const packages = Array.isArray(data) ? data : data.packages;
  return new Map(packages.map((p) => [p.name, p.version.replace(/^v(?=\d)/, '')]));
}

async function read(place: Pick<Place, 'root' | 'component'>, path: string): Promise<string> {
  try {
    return await readFile(join(componentDir(place), ...path.split('/')), 'utf8');
  } catch {
    throw new EngineError(`${path} could not be read in ${place.component.root}`);
  }
}

export async function readManifest(place: Pick<Place, 'root' | 'component'>): Promise<Manifest> {
  return parseManifest(await read(place, 'composer.json'));
}

export async function readLock(place: Pick<Place, 'root' | 'component'>): Promise<Lock> {
  return parseLock(await read(place, 'composer.lock'));
}

export async function readInstalled(
  place: Pick<Place, 'root' | 'component'>,
): Promise<ReadonlyMap<string, string>> {
  return parseInstalled(await read(place, 'vendor/composer/installed.json'));
}

/** The PSR-4 and PSR-0 namespace prefixes an autoload section declares, the fallback left out. */
export function namespacesOf(section: Autoload | undefined): string[] {
  const declared = [
    ...Object.keys(section?.['psr-4'] ?? {}),
    ...Object.keys(section?.['psr-0'] ?? {}),
  ];
  return declared.filter((prefix) => prefix !== '');
}

/** A Laravel project: one that requires the framework, so Larastan's rules apply. */
export function isLaravel(composer: Manifest): boolean {
  return 'laravel/framework' in composer.require || 'laravel/framework' in composer['require-dev'];
}
