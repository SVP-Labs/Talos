import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Component } from '../core/check.js';

/**
 * A path from a report (absolute, or relative to `base`) as a repository-relative path with
 * forward slashes; undefined when it lies outside the checkout at `root`.
 */
export function inRepository(root: string, base: string, file: string): string | undefined {
  const absolute = isAbsolute(file) ? file : resolve(base, file);
  const path = relative(root, absolute);
  if (path === '' || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
    return undefined;
  }
  return path.split(sep).join('/');
}

/** Whether a repository-relative path belongs to the component. */
export function inComponent(component: Component | undefined, path: string): boolean {
  const root = component?.root ?? '.';
  if (root === '.' || root === '') return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix);
}

function trimSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

/** Whether a component's tests and a `tests.full` entry overlap (either holds the other). */
export function overlaps(component: Component | undefined, entry: string): boolean {
  const root = trimSlashes(component?.root ?? '.');
  const path = trimSlashes(entry);
  if (root === '.' || root === '' || path === root) return true;
  return path.startsWith(`${root}/`) || root.startsWith(`${path}/`);
}
