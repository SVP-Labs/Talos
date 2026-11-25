import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { z } from 'zod';

const STRING = /"(?:[^"\\\n]|\\.)*"/g;

/** The string literals of a JSON or JSONC text, comments' included. */
function strings(text: string): string[] {
  return [...text.matchAll(STRING)].flatMap((match) => {
    try {
      const value: unknown = JSON.parse(match[0]);
      return typeof value === 'string' ? [value] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Whether a path, read from the directory `from` (relative to the component's root), points
 * outside the component: up and out of it, or absolute. `//`, the key generated JSON files
 * carry, is neither.
 */
function leavesFrom(from: string): (path: string) => boolean {
  return (path) => {
    if (/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(path)) return true;
    const resolved = posix.join(from, path.replaceAll('\\', '/'));
    return resolved === '..' || resolved.startsWith('../');
  };
}

/** JSONC without its comments; strings are kept whole, whatever they hold. */
function withoutComments(text: string): string {
  return text.replaceAll(
    /("(?:[^"\\\n]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_, kept?: string) => kept ?? ' ',
  );
}

/** JSON without the trailing commas JSONC allows; strings are kept whole. */
function withoutTrailingCommas(text: string): string {
  return text.replaceAll(/("(?:[^"\\\n]|\\.)*")|,(?=\s*[}\]])/g, (_, kept?: string) => kept ?? '');
}

/** What of a tsconfig names further tsconfigs; anything else in it is free. */
const tsconfigLinks = z.looseObject({
  extends: z.union([z.string(), z.array(z.string())]).optional(),
  references: z.array(z.looseObject({ path: z.string() })).optional(),
});

type TsconfigLinks = z.infer<typeof tsconfigLinks>;

/** A tsconfig to read, and whether it is only a probe for a path that may name another. */
type Linked = { readonly file: string; readonly probe: boolean };

/** A tsconfig's links, or undefined when it isn't JSONC of a shape Talos can read. */
function parseTsconfig(text: string): TsconfigLinks | undefined {
  let value: unknown;
  try {
    value = JSON.parse(withoutTrailingCommas(withoutComments(text)));
  } catch {
    return undefined;
  }
  const parsed = tsconfigLinks.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The tsconfigs a tsconfig at `file` extends or references, by their path from the component's
 * root. An `extends` that starts with `.` is a path, a bare one a package, as TypeScript reads
 * them, and `./base` may name `./base.json`, so `./base` itself is only a probe; a reference's path
 * is always relative, and one that doesn't end in `.json` names the `tsconfig.json` in that
 * directory.
 */
function linked(file: string, config: TsconfigLinks): Linked[] {
  const from = posix.dirname(file);
  const extended = config.extends ?? [];
  const bases = (typeof extended === 'string' ? [extended] : extended).filter((base) =>
    base.startsWith('.'),
  );
  return [
    ...bases.flatMap((base) => {
      const path = posix.join(from, base);
      return path.endsWith('.json')
        ? [{ file: path, probe: false }]
        : [
            { file: path, probe: true },
            { file: `${path}.json`, probe: false },
          ];
    }),
    ...(config.references ?? []).map(({ path: reference }) => {
      const path = posix.join(from, reference);
      const file = path.endsWith('.json') ? path : posix.join(path, 'tsconfig.json');
      return { file, probe: false };
    }),
  ];
}

/**
 * Whether Stryker must rewrite the component's tsconfig chain because some path in it points
 * outside the component, which its sandbox doesn't hold. Every string in each file counts as a
 * path from that file's directory, and every tsconfig it extends or references is read in turn;
 * a tsconfig Talos can't read leaves Stryker's rewrite on.
 */
export async function tsconfigLeaves(dir: string): Promise<boolean> {
  const pending: Linked[] = [{ file: 'tsconfig.json', probe: false }];
  const seen = new Set<string>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { file } = next;
    if (seen.has(file)) continue;
    seen.add(file);
    if (leavesFrom('.')(file)) return true;
    const text = await tsconfigText(join(dir, file), next.probe);
    if (text === ABSENT) continue;
    if (text === UNREADABLE) return true;
    const config = parseTsconfig(text);
    if (config === undefined || strings(text).some(leavesFrom(posix.dirname(file)))) return true;
    pending.push(...linked(file, config));
  }
  return false;
}

const ABSENT = Symbol('absent');
const UNREADABLE = Symbol('unreadable');

/**
 * A tsconfig's text. Only a missing file is absent, or a directory where a probe looked; any
 * other error makes it unreadable, which leaves Stryker's rewrite on.
 */
async function tsconfigText(
  path: string,
  probe: boolean,
): Promise<string | typeof ABSENT | typeof UNREADABLE> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    return code === 'ENOENT' || (probe && code === 'EISDIR') ? ABSENT : UNREADABLE;
  }
}
