import { inComponent } from './paths.js';
import type { Component } from '../../core/check.js';

export const PINT_BASE = 'pint.json';

export type PintContext = {
  readonly config: { readonly exclude: readonly string[] };
  readonly component?: Component;
};

/**
 * Laravel's preset, which is PER-CS 2.0 with Laravel's conventions, and strict types declared in
 * every file. Formatting is not a project's choice, so pint.json has no extension. `note` is the
 * generated-file note; `excludes` puts talos.yml's `exclude` in, so an editor formats what the
 * gate checks.
 */
export function renderPint(note: string, ctx?: PintContext): string {
  const root = ctx?.component?.root ?? '.';
  const excluded = (ctx?.config.exclude ?? [])
    .map((path) => inComponent(root, path))
    .filter((path): path is string => path !== undefined && path !== '');
  const config = {
    ...(note === '' ? {} : { '//': note }),
    preset: 'laravel',
    rules: { declare_strict_types: true },
    ...(excluded.length === 0 ? {} : { notPath: excluded }),
  };
  return `${JSON.stringify(config, null, 4)}\n`;
}
