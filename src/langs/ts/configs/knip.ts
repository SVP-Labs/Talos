import { excludeGlobs, excludes, lines, quote } from './shared.js';
import { generatedHeader } from '../../../configs/header.js';
import type { RenderContext } from '../../../core/pack.js';

export const KNIP_BASE = 'knip.config.js';
export const KNIP_PROJECT = 'knip.project.json';

/**
 * Tools Talos runs that nothing in a project refers to, so Knip would call them unused; its
 * plugins see the others through their config files.
 */
export const UNSEEN_BY_KNIP = ['type-coverage'] as const;

/** Keys of the project's file that could only hide unused code, which the base doesn't allow. */
export const KNIP_WEAKENING_KEYS = [
  'rules',
  'include',
  'exclude',
  'ignoreExportsUsedInFile',
] as const;

/**
 * Knip's own defaults are the strict part: every issue type is an error. The base adds
 * `talos.yml`'s exclude and the tools only Talos runs; the project's JSON names its entry
 * points and project files.
 */
export function renderKnip(ctx: RenderContext): string {
  const ignore = excludes(ctx).flatMap((entry) => excludeGlobs(entry).slice(-1));
  return `${generatedHeader('//', ctx.version, KNIP_PROJECT)}import { readFileSync } from 'node:fs';

const project = JSON.parse(readFileSync(new URL('./${KNIP_PROJECT}', import.meta.url), 'utf8'));

/** @type {import('knip').KnipConfig} */
export default {
  ...project,
  ignore: [
${lines(ignore.map(quote), '    ')}    ...(project.ignore ?? []),
  ],
  ignoreDependencies: [
${lines(UNSEEN_BY_KNIP.map(quote), '    ')}    ...(project.ignoreDependencies ?? []),
  ],
};
`;
}

export function knipProjectInitial(): string {
  return '{}\n';
}
