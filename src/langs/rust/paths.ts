import { realpath } from 'node:fs/promises';
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

/** A path as the file system names it: links and Windows short names resolved, no `\\?\`. */
async function realPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * As {@link relativeTo}, for a tool that prints canonical paths (cargo fmt): Windows gives them
 * the `\\?\` prefix and long names, and macOS resolves `/var` to `/private/var`, so `to` and the
 * file are compared as the file system names them.
 */
export async function realRelativeTo(to: string, base: string, file: string): Promise<string> {
  const absolute = isAbsolute(file) ? file : resolve(base, file);
  return relativeTo(await realPath(to), base, await realPath(absolute));
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
