import picomatch from 'picomatch';
import { isDeclaringFile } from '../checks/runtime/declarations.js';
import type { Pack } from '../core/pack.js';
import { DEPTRAC_PROJECT } from '../langs/php/deptrac-config.js';

/**
 * The guard list: files a debt or chore PR may never touch to land without the owner, because
 * they steer the gate, the review, the supply chain, the runtime or the agents themselves.
 */

/** Dependency manifests, lock files and package-manager settings, by file name. */
const MANIFESTS: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.json',
  'deno.jsonc',
  'deno.lock',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'uv.toml',
  'pdm.lock',
  'composer.json',
  'composer.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.sum',
  'Gemfile',
  'Gemfile.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gradle.lockfile',
  'packages.lock.json',
  'Directory.Packages.props',
  'luarocks.lock',
]);

/**
 * Version files the runtime check doesn't read, by file name; every file it reads (Dockerfiles,
 * `.nvmrc` and the rest) is guarded through the same predicate the check uses.
 */
const RUNTIMES: ReadonlySet<string> = new Set(['.ruby-version', '.tool-versions']);

/**
 * Agent instructions, decision records and the project's architecture rules that a tool runs as
 * written rather than through a generated base, by file name, wherever they sit.
 */
const INSTRUCTIONS: ReadonlySet<string> = new Set([
  'CLAUDE.md',
  'DECISIONS.md',
  'CODEOWNERS',
  DEPTRAC_PROJECT,
]);

const PATTERNS: readonly RegExp[] = [
  /^\.github\//,
  /^\.claude\//,
  /(?:^|\/)requirements[^/]*\.(?:txt|in)$/,
  /(?:^|\/)requirements\/[^/]+\.(?:txt|in)$/,
  /(?:^|\/)constraints[^/]*\.txt$/,
  /\.(?:rockspec|gemspec|csproj|fsproj|vbproj)$/,
];

export type GuardContext = {
  /** The tool-config extension files the packs declare, relative to a component's root. */
  readonly extensions: readonly string[];
  /** `docs.briefs` and `docs.glossary` from `talos.yml`. */
  readonly briefs: string;
  readonly glossary: string;
};

/** Every tool-config extension file the packs declare, each once. */
export function extensionFiles(packs: readonly Pick<Pack, 'generated'>[]): string[] {
  const paths = packs.flatMap((pack) =>
    (pack.generated ?? []).flatMap((file) =>
      file.extension === undefined ? [] : [file.extension.path],
    ),
  );
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function withoutTrailingSlash(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

function under(path: string, dir: string): boolean {
  const prefix = withoutTrailingSlash(dir);
  return prefix !== '' && (path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Whether a path is on the guard list. Extension files count at any depth, since a component may
 * sit anywhere; so do manifests, Dockerfiles and agent instructions.
 */
export function isGuarded(path: string, ctx: GuardContext): boolean {
  const name = basename(path);
  if (path === 'talos.yml' || path === ctx.glossary || under(path, ctx.briefs)) return true;
  if (MANIFESTS.has(name) || RUNTIMES.has(name) || INSTRUCTIONS.has(name)) return true;
  if (isDeclaringFile(path)) return true;
  if (ctx.extensions.some((ext) => path === ext || path.endsWith(`/${ext}`))) return true;
  return PATTERNS.some((pattern) => pattern.test(path));
}

export function guardedPaths(paths: readonly string[], ctx: GuardContext): string[] {
  return paths.filter((path) => isGuarded(path, ctx));
}

/**
 * The paths among `paths` that `talos.yml`'s `protected` globs match. A glob without wildcards
 * names a file or a whole folder.
 */
export function protectedPaths(paths: readonly string[], globs: readonly string[]): string[] {
  if (globs.length === 0) return [];
  const expanded = globs.flatMap((glob) => [glob, `${withoutTrailingSlash(glob)}/**`]);
  const matches = picomatch(expanded, { dot: true });
  return paths.filter((path) => matches(path));
}
