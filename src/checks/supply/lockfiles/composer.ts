import { z } from 'zod';
import { fromGit, fromUrl, LOCAL, type Locked, PUBLIC_REGISTRY, type Source } from './locked.js';

const location = z.looseObject({ type: z.string().default(''), url: z.string().default('') });

const entry = z.looseObject({
  name: z.string(),
  version: z.string(),
  source: location.optional(),
  dist: location.optional(),
  'notification-url': z.string().optional(),
  license: z.array(z.string()).optional(),
});

const lockfile = z.looseObject({
  packages: z.array(entry).default([]),
  'packages-dev': z.array(entry).default([]),
});

type Entry = z.infer<typeof entry>;

/**
 * Packagist's packages carry its download notification URL; a `dev-` version is a branch
 * checkout even from Packagist. Anything else came from a VCS, a URL or a path repository.
 */
function sourceOf(found: Entry): Source {
  if (found.dist?.type === 'path') return LOCAL;
  const fromPackagist = found['notification-url']?.includes('packagist.org') === true;
  if (fromPackagist && !found.version.startsWith('dev-')) return PUBLIC_REGISTRY;
  if (found.source !== undefined && found.source.url !== '') return fromGit(found.source.url);
  return fromUrl(found.dist?.url ?? found.name);
}

/** `composer.lock`: `packages` and `packages-dev`. */
export function parseComposerLock(text: string): Locked[] {
  const parsed = lockfile.parse(JSON.parse(text));
  return [...parsed.packages, ...parsed['packages-dev']].map((found) => ({
    ecosystem: 'packagist',
    name: found.name,
    version: found.version,
    source: sourceOf(found),
    ...(found.license === undefined ? {} : { licences: found.license }),
  }));
}
