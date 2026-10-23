import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parseCargoLock } from './cargo.js';
import { parseComposerLock } from './composer.js';
import { type Locked, unreadable } from './locked.js';
import { parseNpmLock } from './npm.js';
import { parsePnpmLock } from './pnpm.js';
import { parsePoetryLock, parseUvLock } from './python.js';
import { parseYarnLock } from './yarn.js';
import type { RepoFacts } from '../../../repo/facts.js';

export type { Ecosystem, Locked, Source } from './locked.js';
export { isPublic, isRegistry, spec } from './locked.js';

/** Each lockfile Talos reads, by file name, and how. */
const PARSERS: Readonly<Record<string, (text: string) => Locked[]>> = {
  'pnpm-lock.yaml': parsePnpmLock,
  'package-lock.json': parseNpmLock,
  'npm-shrinkwrap.json': parseNpmLock,
  'yarn.lock': parseYarnLock,
  'uv.lock': parseUvLock,
  'poetry.lock': parsePoetryLock,
  'composer.lock': parseComposerLock,
  'Cargo.lock': parseCargoLock,
};

export const LOCKFILE_NAMES: readonly string[] = Object.keys(PARSERS);

/** The tracked lockfiles Talos reads, repository-relative, sorted. */
export function lockfiles(facts: RepoFacts): string[] {
  return facts
    .matching(...LOCKFILE_NAMES.map((name) => `**/${name}`))
    .sort((a, b) => a.localeCompare(b));
}

/** Reads a lockfile's text; throws `EngineError` when it isn't the format its name says. */
export function parseLockfile(path: string, text: string): Locked[] {
  const parser = PARSERS[posix.basename(path)];
  if (parser === undefined) return [];
  try {
    return parser(text);
  } catch (error) {
    throw unreadable(path, error);
  }
}

export async function readLockfile(root: string, path: string): Promise<Locked[]> {
  let text: string;
  try {
    text = await readFile(join(root, path), 'utf8');
  } catch (error) {
    throw unreadable(path, error);
  }
  return parseLockfile(path, text);
}
