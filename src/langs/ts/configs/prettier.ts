import { excludes, quote } from './shared.js';
import { generatedHeader } from '../../../configs/header.js';
import type { RenderContext } from '../../../core/pack.js';
import { LOCKFILES } from '../files.js';

export const PRETTIER_CONFIG = 'prettier.config.js';
export const PRETTIER_IGNORE = '.prettierignore';

/**
 * Fixed for every project: formatting is not a project's choice. Every option `.editorconfig`
 * could otherwise set is pinned too.
 */
export const PRETTIER_OPTIONS = {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  endOfLine: 'lf',
} as const;

export function renderPrettier(ctx: RenderContext): string {
  const options = Object.entries(PRETTIER_OPTIONS)
    .map(
      ([key, value]) => `  ${key}: ${typeof value === 'string' ? quote(value) : String(value)},\n`,
    )
    .join('');
  return `${generatedHeader('//', ctx.version)}/** @type {import('prettier').Config} */
export default {
${options}};
`;
}

/**
 * Prettier skips lockfiles, the files Talos renders (it formats nothing a project can't edit),
 * and `talos.yml`'s exclude, so an editor formats what the gate checks.
 */
export function renderPrettierIgnore(ctx: RenderContext, generated: readonly string[]): string {
  const anchored = excludes(ctx).map((entry) => `/${entry}`);
  const entries = [...LOCKFILES, ...generated.map((path) => `/${path}`), ...anchored];
  return `${generatedHeader('#', ctx.version)}${entries.join('\n')}\n`;
}
