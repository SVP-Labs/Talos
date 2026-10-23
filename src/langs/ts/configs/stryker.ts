import { inComponent, isCode, rootOf, stripSlashes } from '../files.js';
import { lines, quote } from './shared.js';
import { generatedHeader } from '../../../configs/header.js';
import type { RenderContext } from '../../../core/pack.js';

export const STRYKER_BASE = 'stryker.config.mjs';
export const STRYKER_PROJECT = 'stryker.project.json';

/** `talos.yml`'s mutation paths under the component, as Stryker's `mutate` globs. */
export function mutateGlobs(ctx: RenderContext): string[] {
  const root = rootOf(ctx.component);
  const here = ctx.config.mutation
    .map((path) => stripSlashes(path))
    .filter((path) => root === '.' || path.startsWith(`${root}/`))
    .map((path) => inComponent(root, path));
  const files = here.filter((path) => isCode(path));
  const dirs = here.filter((path) => !isCode(path));
  if (dirs.length === 0) return files;
  return [
    ...files,
    ...dirs.map((dir) => `${dir}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`),
    '!**/*.{test,spec}.*',
  ];
}

/**
 * Stryker through Vitest. The base mutates `talos.yml`'s mutation paths and writes the JSON
 * report the mutation check reads; the project's JSON may set the rest (a Vitest config of its
 * own, concurrency, ignore patterns).
 */
export function renderStryker(ctx: RenderContext): string {
  const mutate = mutateGlobs(ctx);
  const mutateLine =
    mutate.length === 0 ? '' : `  mutate: [\n${lines(mutate.map(quote), '    ')}  ],\n`;
  return `${generatedHeader('//', ctx.version, STRYKER_PROJECT)}import { readFileSync } from 'node:fs';

const project = JSON.parse(readFileSync(new URL('./${STRYKER_PROJECT}', import.meta.url), 'utf8'));

export default {
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  ...project,
  plugins: ['@stryker-mutator/vitest-runner', ...(project.plugins ?? [])],
${mutateLine}  reporters: ['clear-text', 'progress', 'html', 'json'],
  tempDirName: '.stryker-tmp',
};
`;
}

/** Stryker's own timeouts, which the base leaves as they are. */
const TIMEOUT_MS = 5000;
const TIMEOUT_FACTOR = 1.5;

type Project = Readonly<Record<string, unknown>>;

function isSet(value: unknown): boolean {
  return value !== undefined && value !== false;
}

function isListed(value: unknown): boolean {
  return value !== undefined && !(Array.isArray(value) && value.length === 0);
}

/** Whether a setting is below `floor`: any value but a number at or above it. */
function isBelow(value: unknown, floor: number): boolean {
  return value !== undefined && !(typeof value === 'number' && value >= floor);
}

function excludedMutations(project: Project): unknown {
  const { mutator } = project;
  return typeof mutator === 'object' && mutator !== null && 'excludedMutations' in mutator
    ? mutator.excludedMutations
    : undefined;
}

const WEAKENING_SETTINGS: readonly {
  readonly setting: string;
  readonly how: string;
  readonly weakens: (project: Project) => boolean;
}[] = [
  {
    setting: 'testRunner',
    how: 'sets another test runner, which then decides what kills a mutant',
    weakens: (p) => p.testRunner !== undefined && p.testRunner !== 'vitest',
  },
  {
    setting: 'ignoreStatic',
    how: 'never runs static mutants',
    weakens: (p) => isSet(p.ignoreStatic),
  },
  {
    setting: 'ignorers',
    how: 'never mutates the code its ignorers pick',
    weakens: (p) => isListed(p.ignorers),
  },
  {
    setting: 'checkers',
    how: 'drops the mutants a checker rejects before any test runs',
    weakens: (p) => isListed(p.checkers),
  },
  {
    setting: 'mutator.excludedMutations',
    how: 'leaves the mutations it names out',
    weakens: (p) => isListed(excludedMutations(p)),
  },
  {
    setting: 'timeoutMS',
    how: 'lowers the timeout, and a mutant that times out counts as killed',
    weakens: (p) => isBelow(p.timeoutMS, TIMEOUT_MS),
  },
  {
    setting: 'timeoutFactor',
    how: 'lowers the timeout, and a mutant that times out counts as killed',
    weakens: (p) => isBelow(p.timeoutFactor, TIMEOUT_FACTOR),
  },
  { setting: 'dryRunOnly', how: 'runs no mutant at all', weakens: (p) => isSet(p.dryRunOnly) },
];

/**
 * What the project's file sets that the base would take, since it spreads the file, and that
 * never runs a mutant or counts one as killed without a test failing. The rest it may set (a
 * Vitest config of its own, concurrency) changes no mutant's fate, or only makes one harder to
 * kill.
 */
export function weakerStryker(
  project: Project,
): { readonly setting: string; readonly how: string }[] {
  return WEAKENING_SETTINGS.filter((w) => w.weakens(project)).map(({ setting, how }) => ({
    setting,
    how,
  }));
}

export function strykerProjectInitial(): string {
  return '{}\n';
}
