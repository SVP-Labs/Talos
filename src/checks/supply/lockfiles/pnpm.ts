import { parse } from 'yaml';
import { z } from 'zod';
import {
  before,
  fromFile,
  fromGit,
  fromUrl,
  LOCAL,
  type Locked,
  npmSource,
  PUBLIC_REGISTRY,
  type Source,
  splitSpec,
} from './locked.js';

const resolution = z.looseObject({
  type: z.string().optional(),
  tarball: z.string().optional(),
  repo: z.string().optional(),
  directory: z.string().optional(),
});

const entry = z.looseObject({ resolution: resolution.optional(), version: z.string().optional() });

const lockfile = z.looseObject({ packages: z.record(z.string(), entry).nullish() });

type Entry = z.infer<typeof entry>;

const PLAIN_VERSION = /^\d[\w.+-]*$/;

function sourceOf(name: string, keyVersion: string, locked: Entry): Source {
  const found = locked.resolution;
  if (found?.type === 'git') return fromGit(found.repo ?? keyVersion);
  if (found?.type === 'directory') return LOCAL;
  if (found?.tarball !== undefined) {
    if (found.tarball.startsWith('file:')) return fromFile(found.tarball.slice('file:'.length));
    if (!PLAIN_VERSION.test(keyVersion)) return fromUrl(found.tarball);
    return npmSource(name, keyVersion, found.tarball);
  }
  if (!PLAIN_VERSION.test(keyVersion)) return fromUrl(keyVersion);
  return PUBLIC_REGISTRY;
}

/**
 * `pnpm-lock.yaml` (lockfile versions 6 and 9): every package under `packages`, keyed
 * `name@version`, where a git or tarball dependency's version is its URL.
 */
export function parsePnpmLock(text: string): Locked[] {
  const packages = lockfile.parse(parse(text)).packages ?? {};
  return Object.entries(packages).map(([key, found]) => {
    const { name, rest } = splitSpec(key.replace(/^\//, ''));
    const keyVersion = before(rest, ['(']);
    return {
      ecosystem: 'npm',
      name,
      version: found.version ?? keyVersion,
      source: sourceOf(name, keyVersion, found),
    };
  });
}
