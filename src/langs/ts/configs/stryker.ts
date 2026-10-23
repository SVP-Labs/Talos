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

export function strykerProjectInitial(): string {
  return '{}\n';
}
