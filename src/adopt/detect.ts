import { posix } from 'node:path';
import type { Reader } from './scaffold.js';
import { GENERATED_MARKER } from '../configs/header.js';
import type { Component, Lang, Os } from '../core/check.js';

/**
 * What `talos adopt` reads off a repository: its components from their manifests, the committed
 * generated or vendored code to exclude, and where its glossary and briefs live. Pure: every
 * function takes the tracked files and a reader.
 */

const VENDORED: ReadonlySet<string> = new Set([
  'vendor',
  'third_party',
  'third-party',
  'node_modules',
  'bower_components',
  'lua_modules',
  '.venv',
  'venv',
  'site-packages',
  'generated',
  '__generated__',
  'dist',
]);

const GENERATED_HEAD =
  /@generated|code generated .{0,80}do not edit|(?:auto-?|machine[ -])generated|this file (?:is|was) generated/i;

const CODE = /\.(?:[cm]?[jt]sx?|py|php|lua|rs|go|java|kt|cs|swift|rb)$/;

/** The directory holding the first vendored folder on a path, or `undefined`. */
function vendoredRoot(file: string): string | undefined {
  const parts = file.split('/');
  const index = parts.slice(0, -1).findIndex((part) => VENDORED.has(part));
  return index === -1 ? undefined : parts.slice(0, index + 1).join('/');
}

function generatedFile(file: string, read: Reader): boolean {
  if (!CODE.test(file)) return false;
  const head = (read(file) ?? '').slice(0, 600);
  return !head.includes(GENERATED_MARKER) && GENERATED_HEAD.test(head);
}

function withoutNested(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  return sorted.filter(
    (path) => !sorted.some((other) => other !== path && path.startsWith(`${other}/`)),
  );
}

/** A bundler's output folder: an `index.html` beside `assets/` holding hashed bundles. */
function bundleRoots(files: readonly string[]): string[] {
  const hashed = /^(.*)\/assets\/[^/]+-[\w-]{8}\.(?:js|css)$/;
  const roots = files.flatMap((file) => {
    const root = hashed.exec(file)?.[1];
    return root !== undefined && files.includes(`${root}/index.html`) ? [root] : [];
  });
  return [...new Set(roots)];
}

/**
 * Guesses at committed generated or vendored code for `exclude`: vendored folders, a bundler's
 * output, minified bundles, and files whose first lines say they were generated. The owner
 * reviews them in the bootstrap PR.
 */
export function guessExclude(files: readonly string[], read: Reader): string[] {
  const vendored = files.flatMap((file) => vendoredRoot(file) ?? []);
  const roots = withoutNested([...vendored, ...bundleRoots(files)]);
  const outside = files.filter((file) => !roots.some((root) => file.startsWith(`${root}/`)));
  const minified = ['js', 'css']
    .filter((kind) => outside.some((file) => file.endsWith(`.min.${kind}`)))
    .map((kind) => `**/*.min.${kind}`);
  const generated = outside.filter((file) => generatedFile(file, read)).slice(0, 50);
  return [...roots, ...minified, ...generated];
}

const dirOf = (file: string): string => {
  const dir = posix.dirname(file);
  return dir === '' ? '.' : dir;
};

function inside(path: string, root: string): boolean {
  return root === '.' || path === root || path.startsWith(`${root}/`);
}

function named(files: readonly string[], test: (base: string) => boolean): string[] {
  return files.filter((file) => test(posix.basename(file))).map(dirOf);
}

type Roots = { readonly roots: string[]; readonly workspaces: string[] };

/** Drops roots nested under a workspace root of the same language: the workspace holds them. */
function outerRoots({ roots, workspaces }: Roots): string[] {
  const unique = [...new Set(roots)].sort((a, b) => a.localeCompare(b));
  return unique.filter(
    (root) => !workspaces.some((outer) => outer !== root && inside(root, outer)),
  );
}

function tsRoots(files: readonly string[], read: Reader): string[] {
  const manifests = named(files, (base) => base === 'package.json');
  const sources = files.filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file));
  const roots = manifests.filter(
    (root) =>
      files.includes(posix.join(root, 'tsconfig.json')) ||
      sources.some((file) => inside(file, root)),
  );
  const workspaces = roots.filter(
    (root) =>
      files.includes(posix.join(root, 'pnpm-workspace.yaml')) ||
      /"workspaces"\s*:/.test(read(posix.join(root, 'package.json')) ?? ''),
  );
  return outerRoots({ roots, workspaces });
}

/** A `setup.py` or `setup.cfg` that packages something, not a module that is merely named so. */
function packagingFile(file: string, read: Reader): boolean {
  const base = posix.basename(file);
  if (base === 'pyproject.toml') return true;
  if (base === 'setup.py') return /setuptools|distutils/.test(read(file) ?? '');
  return base === 'setup.cfg' && /^\[(?:metadata|options)\]/m.test(read(file) ?? '');
}

function pyRoots(files: readonly string[], read: Reader): string[] {
  const projects = files.filter((file) => packagingFile(file, read)).map(dirOf);
  const pySources = files.filter((file) => file.endsWith('.py'));
  const requirements = named(files, (b) => /^requirements[\w.-]*\.txt$/.test(b)).filter((root) =>
    pySources.some((file) => inside(file, root)),
  );
  const roots = [...projects, ...requirements];
  const workspaces = roots.filter((root) =>
    (read(posix.join(root, 'pyproject.toml')) ?? '').includes('[tool.uv.workspace]'),
  );
  return outerRoots({ roots, workspaces });
}

function rustRoots(files: readonly string[], read: Reader): string[] {
  const roots = named(files, (base) => base === 'Cargo.toml');
  const workspaces = roots.filter((root) =>
    /^\[workspace\]/m.test(read(posix.join(root, 'Cargo.toml')) ?? ''),
  );
  return outerRoots({ roots, workspaces });
}

function luaRoots(files: readonly string[]): string[] {
  const rockspecs = named(files, (base) => base.endsWith('.rockspec'));
  if (rockspecs.length > 0) return outerRoots({ roots: rockspecs, workspaces: [] });
  return files.some((file) => file.endsWith('.lua')) ? ['.'] : [];
}

/** An `--os` override: for every component, one language's, or one component's. */
export type OsOverride = { readonly lang?: Lang; readonly root?: string; readonly os: Os[] };

function osFor(lang: Lang, root: string, overrides: readonly OsOverride[]): Os[] {
  const match = overrides.findLast(
    (o) => (o.lang === undefined || o.lang === lang) && (o.root === undefined || o.root === root),
  );
  return match === undefined ? ['linux'] : [...match.os];
}

/** One component per language and manifest root, in the order the packs run. */
export function detectComponents(
  files: readonly string[],
  read: Reader,
  overrides: readonly OsOverride[] = [],
): Component[] {
  const byLang: [Lang, string[]][] = [
    ['ts', tsRoots(files, read)],
    ['py', pyRoots(files, read)],
    ['php', outerRoots({ roots: named(files, (b) => b === 'composer.json'), workspaces: [] })],
    ['lua', luaRoots(files)],
    ['rust', rustRoots(files, read)],
  ];
  return byLang.flatMap(([lang, roots]) =>
    roots.map((root) => ({ lang, root, os: osFor(lang, root, overrides) })),
  );
}

const GLOSSARIES = [
  'docs/glossary.md',
  'GLOSSARY.md',
  'glossary.md',
  'docs/GLOSSARY.md',
  'UBIQUITOUS_LANGUAGE.md',
  'docs/UBIQUITOUS_LANGUAGE.md',
  'CONTEXT.md',
];

const BRIEFS = ['docs/requirements', 'docs/briefs', 'docs/specs', 'docs/rfcs'];

/** The glossary and briefs folder the repository already has, or Talos's defaults. */
export function detectDocs(files: readonly string[]): { glossary: string; briefs: string } {
  const glossary = GLOSSARIES.find((path) => files.includes(path)) ?? 'docs/glossary.md';
  const briefs =
    BRIEFS.find((dir) => files.some((f) => f.startsWith(`${dir}/`) && f.endsWith('.md'))) ??
    'docs/requirements';
  return { glossary, briefs };
}
