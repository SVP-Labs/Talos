import { parse } from 'smol-toml';
import { z } from 'zod';
import { fromGit, fromUrl, LOCAL, type Locked, PUBLIC_REGISTRY, type Source } from './locked.js';

const CRATES_IO = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
]);

const lockfile = z.looseObject({
  package: z
    .array(z.looseObject({ name: z.string(), version: z.string(), source: z.string().optional() }))
    .default([]),
});

/** A package without `source` is a workspace member or a path dependency. */
function sourceOf(source: string | undefined): Source {
  if (source === undefined || source.startsWith('path+')) return LOCAL;
  if (CRATES_IO.has(source)) return PUBLIC_REGISTRY;
  if (/^(?:registry|sparse)\+/.test(source)) return { kind: 'registry', public: false };
  if (source.startsWith('git+')) return fromGit(source.slice('git+'.length));
  return fromUrl(source);
}

/** `Cargo.lock`: each `[[package]]` with its `source`. */
export function parseCargoLock(text: string): Locked[] {
  return lockfile.parse(parse(text)).package.map((found) => ({
    ecosystem: 'crates',
    name: found.name,
    version: found.version,
    source: sourceOf(found.source),
  }));
}
