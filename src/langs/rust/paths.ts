import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  APPLIES,
  type Applicability,
  type ApplyContext,
  type Component,
  skip,
} from '../../core/check.js';
import { componentOf, inComponent } from '../../core/component.js';
import { underRoot } from '../../repo/facts.js';

export function component(ctx: { readonly component?: Component }): Component {
  return componentOf(ctx, 'rust');
}

function posixPath(path: string): string {
  return path.split(sep).join('/').replaceAll('\\', '/');
}

/**
 * A path a tool printed, absolute or relative to `base` (an absolute directory), made relative
 * to `to` with forward slashes; `..` segments show it lies outside.
 */
export function relativeTo(to: string, base: string, file: string): string {
  const absolute = isAbsolute(file) ? file : resolve(base, file);
  return posixPath(relative(to, absolute));
}

/** Whether a relative path stays inside the directory it is relative to. */
export function isInside(path: string): boolean {
  return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}

/** The component's tracked Rust sources, relative to its root, never a build's output. */
export function rustFiles(ctx: Pick<ApplyContext, 'facts' | 'component'>): string[] {
  const root = component(ctx).root;
  return underRoot(ctx.facts.matching('**/*.rs'), root)
    .map((file) => inComponent(root, file))
    .filter((file): file is string => file !== undefined && !file.split('/').includes('target'));
}

const TEST_DIRS = new Set(['tests', 'benches']);

/** Test code by where Cargo looks for it: a `tests` or `benches` directory. */
export function isTestPath(path: string): boolean {
  return path
    .split('/')
    .slice(0, -1)
    .some((part) => TEST_DIRS.has(part));
}

export function hasRust(ctx: Pick<ApplyContext, 'facts' | 'component'>): Applicability {
  return rustFiles(ctx).length > 0 ? APPLIES : skip('the component has no Rust files');
}
