import { parse } from 'smol-toml';
import { z } from 'zod';
import {
  fromFile,
  fromGit,
  fromUrl,
  LOCAL,
  type Locked,
  PUBLIC_REGISTRY,
  type Source,
} from './locked.js';

const PYPI = /^https:\/\/pypi\.org\/simple\/?$/;

const uvSource = z.looseObject({
  registry: z.string().optional(),
  git: z.string().optional(),
  url: z.string().optional(),
  path: z.string().optional(),
});

const uvLock = z.looseObject({
  package: z
    .array(
      z.looseObject({
        name: z.string(),
        version: z.string().optional(),
        source: uvSource.optional(),
      }),
    )
    .default([]),
});

function uvSourceOf(source: z.infer<typeof uvSource> | undefined): Source {
  if (source?.registry !== undefined) {
    return { kind: 'registry', public: PYPI.test(source.registry) };
  }
  if (source?.git !== undefined) return fromGit(source.git);
  if (source?.url !== undefined) return fromUrl(source.url);
  if (source?.path !== undefined) return fromFile(source.path);
  return LOCAL;
}

/** `uv.lock`: each `[[package]]` with its `source` table. */
export function parseUvLock(text: string): Locked[] {
  return uvLock.parse(parse(text)).package.map((found) => ({
    ecosystem: 'pypi',
    name: found.name,
    version: found.version ?? '0',
    source: uvSourceOf(found.source),
  }));
}

const poetrySource = z.looseObject({ type: z.string(), url: z.string().default('') });

const poetryLock = z.looseObject({
  package: z
    .array(
      z.looseObject({ name: z.string(), version: z.string(), source: poetrySource.optional() }),
    )
    .default([]),
});

function poetrySourceOf(source: z.infer<typeof poetrySource> | undefined): Source {
  if (source === undefined) return PUBLIC_REGISTRY;
  switch (source.type) {
    case 'git': {
      return fromGit(source.url);
    }
    case 'file': {
      return fromFile(source.url);
    }
    case 'directory': {
      return LOCAL;
    }
    case 'legacy': {
      return { kind: 'registry', public: false };
    }
    default: {
      return fromUrl(source.url);
    }
  }
}

/** `poetry.lock`: a package without a `[package.source]` comes from PyPI. */
export function parsePoetryLock(text: string): Locked[] {
  return poetryLock.parse(parse(text)).package.map((found) => ({
    ecosystem: 'pypi',
    name: found.name,
    version: found.version,
    source: poetrySourceOf(found.source),
  }));
}
