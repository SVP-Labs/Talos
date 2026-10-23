import { DEPTRAC_BASE, renderDeptracBase } from './deptrac-config.js';
import { toNeon } from './neon.js';
import { phpFiles, tracks } from './paths.js';
import { initialPhpmdProject, PHPMD_BASE, PHPMD_PROJECT, renderPhpmd } from './phpmd-config.js';
import { PHPSTAN_BASE, PHPSTAN_PROJECT, renderPhpstanBase } from './phpstan-config.js';
import { PINT_BASE, renderPint } from './pint-config.js';
import { topLevel } from './scope.js';
import { generatedJsonNote } from '../../configs/header.js';
import type { ApplyContext } from '../../core/check.js';
import type { Generated, RenderContext } from '../../core/pack.js';

const hasPhp = (ctx: ApplyContext): boolean => phpFiles(ctx).length > 0;

/** A Laravel application tracks `artisan` at its root; its base includes Larastan. */
function laravel(ctx: RenderContext): boolean {
  return ctx.component !== undefined && tracks({ ...ctx, component: ctx.component }, 'artisan');
}

/** The directories (and root files) PHPStan analyses in an editor: where the PHP is today. */
function initialPhpstanProject(ctx: RenderContext): string {
  const files =
    ctx.component === undefined ? [] : phpFiles({ facts: ctx.facts, component: ctx.component });
  const { dirs, rootFiles } = topLevel(files);
  const paths = [...dirs, ...rootFiles];
  return `# This project's additions to ${PHPSTAN_BASE}, which may only tighten it.\n${toNeon({
    parameters: { paths: paths.length === 0 ? ['.'] : paths },
  })}`;
}

export const phpstanBase: Generated = {
  path: PHPSTAN_BASE,
  scope: 'component',
  langs: ['php'],
  applies: hasPhp,
  render: (ctx) => renderPhpstanBase(ctx.version, laravel(ctx)),
  extension: { path: PHPSTAN_PROJECT, initial: initialPhpstanProject },
};

export const phpmdBase: Generated = {
  path: PHPMD_BASE,
  scope: 'component',
  langs: ['php'],
  applies: hasPhp,
  render: (ctx) => renderPhpmd(generatedJsonNote(ctx.version, PHPMD_PROJECT), PHPMD_PROJECT),
  extension: { path: PHPMD_PROJECT, initial: initialPhpmdProject },
};

export const pintBase: Generated = {
  path: PINT_BASE,
  scope: 'component',
  langs: ['php'],
  applies: hasPhp,
  render: (ctx) => renderPint(generatedJsonNote(ctx.version), ctx),
};

export const deptracBase: Generated = {
  path: DEPTRAC_BASE,
  scope: 'component',
  langs: ['php'],
  applies: hasPhp,
  render: (ctx) => renderDeptracBase(ctx.version),
};

export const PHP_GENERATED: readonly Generated[] = [phpstanBase, phpmdBase, pintBase, deptracBase];
