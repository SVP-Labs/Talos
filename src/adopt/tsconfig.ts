import { posix } from 'node:path';
import { z } from 'zod';
import type { Draft } from './draft.js';
import type { TalosConfig } from '../config/schema.js';
import { stripJsonComments } from '../langs/py/pyright-config.js';
import { TSCONFIG_BASE } from '../langs/ts/configs/tsconfig.js';
import { repoFacts } from '../repo/facts.js';

/**
 * A TypeScript component's `tsconfig.json` files start from the generated base, so the editor
 * and a plain `tsc` hold the code to the flags the gate does. Adoption writes the file only
 * when there is none; one the project has stays as it is, and whoever adopts is told to make it
 * extend the base.
 */

/** How deep `extends` is followed; a longer chain than any real project's is a loop. */
const MAX_DEPTH = 8;

const settings = z.object({ extends: z.union([z.string(), z.array(z.string())]).optional() });

/** The `extends` entries of a tsconfig's text; none when it can't be read. */
function extendsOf(text: string): string[] {
  try {
    const parsed = settings.safeParse(JSON.parse(stripJsonComments(text)));
    const value = parsed.success ? parsed.data.extends : undefined;
    return value === undefined ? [] : [value].flat();
  } catch {
    return [];
  }
}

/**
 * The file an `extends` entry names, as tsc finds it: a relative path, with `.json` added when
 * the path itself is no file. A package's config (`@tsconfig/node22`) is not followed.
 */
function extended(draft: Draft, from: string, entry: string): string | undefined {
  const value = entry.replaceAll('\\', '/');
  if (!value.startsWith('./') && !value.startsWith('../')) return undefined;
  const path = posix.normalize(posix.join(posix.dirname(from), value));
  if (path.startsWith('../')) return undefined;
  return draft.has(path) || path.endsWith('.json') ? path : `${path}.json`;
}

function reachesBase(draft: Draft, file: string, bases: ReadonlySet<string>, depth = 0): boolean {
  if (bases.has(file)) return true;
  const text = depth > MAX_DEPTH ? undefined : draft.read(file);
  if (text === undefined) return false;
  return extendsOf(text).some((entry) => {
    const next = extended(draft, file, entry);
    return next !== undefined && reachesBase(draft, next, bases, depth + 1);
  });
}

/** The base nearest above `file`: the one of the deepest component holding it. */
function nearestBase(file: string, bases: readonly string[]): string | undefined {
  return bases
    .filter((base) => {
      const dir = posix.dirname(base);
      return dir === '.' || file.startsWith(`${dir}/`);
    })
    .sort((a, b) => b.length - a.length)[0];
}

function relativeTo(file: string, base: string): string {
  const path = posix.relative(posix.dirname(file), base);
  return path.startsWith('.') ? path : `./${path}`;
}

/**
 * A step for each `tsconfig.json` the TypeScript checks read that doesn't extend a generated
 * base, directly or through the configs it extends. `bases` are the `tsconfig.talos.json`
 * files adoption renders.
 */
export function tsconfigSteps(draft: Draft, config: TalosConfig, bases: readonly string[]): void {
  const known = new Set(bases.filter((base) => posix.basename(base) === TSCONFIG_BASE));
  if (known.size === 0) return;
  const files = repoFacts(draft.files(), config.exclude).files;
  for (const file of files.filter((f) => posix.basename(f) === 'tsconfig.json')) {
    const base = nearestBase(file, [...known]);
    if (base === undefined || reachesBase(draft, file, known)) continue;
    draft.next(
      `make ${file} extend ${relativeTo(file, base)} (or extend a tsconfig that does): the base holds the flags the gate checks with, and adoption never rewrites your tsconfig`,
    );
  }
}
