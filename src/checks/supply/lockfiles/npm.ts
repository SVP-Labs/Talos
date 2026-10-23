import { z } from 'zod';
import {
  fromGit,
  fromUrl,
  LOCAL,
  type Locked,
  npmSource,
  PUBLIC_REGISTRY,
  type Source,
} from './locked.js';

type V1Entry = {
  readonly version?: string | undefined;
  readonly resolved?: string | undefined;
  readonly dependencies?: Readonly<Record<string, V1Entry>> | undefined;
};

const v1Entry: z.ZodType<V1Entry> = z.lazy(() =>
  z.looseObject({
    version: z.string().optional(),
    resolved: z.string().optional(),
    dependencies: z.record(z.string(), v1Entry).optional(),
  }),
);

const entry = z.looseObject({
  name: z.string().optional(),
  version: z.string().optional(),
  resolved: z.string().optional(),
  link: z.boolean().optional(),
  license: z.unknown().optional(),
});

const lockfile = z.looseObject({
  packages: z.record(z.string(), entry).optional(),
  dependencies: z.record(z.string(), v1Entry).optional(),
});

const PLAIN_VERSION = /^\d[\w.+-]*$/;

function sourceOf(name: string, version: string, resolved: string | undefined): Source {
  if (resolved !== undefined) return npmSource(name, version, resolved);
  if (PLAIN_VERSION.test(version)) return PUBLIC_REGISTRY;
  if (/^(?:git\+|git:|github:)/.test(version)) return fromGit(version);
  return fromUrl(version);
}

function fromPackages(packages: Readonly<Record<string, z.infer<typeof entry>>>): Locked[] {
  return Object.entries(packages).flatMap(([path, found]): Locked[] => {
    if (path === '') return [];
    const marker = path.lastIndexOf('node_modules/');
    const name = found.name ?? path.slice(marker + 'node_modules/'.length);
    const version = found.version ?? '0.0.0';
    const local = marker < 0 || found.link === true;
    const licence = typeof found.license === 'string' ? { licences: [found.license] } : {};
    return [
      {
        ecosystem: 'npm',
        name,
        version,
        source: local ? LOCAL : sourceOf(name, version, found.resolved),
        ...licence,
      },
    ];
  });
}

function fromV1(dependencies: Readonly<Record<string, V1Entry>>): Locked[] {
  return Object.entries(dependencies).flatMap(([name, found]): Locked[] => {
    const version = found.version ?? '0.0.0';
    const own: Locked = {
      ecosystem: 'npm',
      name,
      version,
      source: sourceOf(name, version, found.resolved),
    };
    return [own, ...fromV1(found.dependencies ?? {})];
  });
}

/** `package-lock.json` and `npm-shrinkwrap.json`: the `packages` map, or v1's nested tree. */
export function parseNpmLock(text: string): Locked[] {
  const parsed = lockfile.parse(JSON.parse(text));
  if (parsed.packages !== undefined) return fromPackages(parsed.packages);
  return fromV1(parsed.dependencies ?? {});
}
