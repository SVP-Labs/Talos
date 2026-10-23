import { access } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { ApplyContext, Component, Os } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import { underRoot } from '../../repo/facts.js';

/** Where a component's tools run: its checkout and the OS it runs on. */
export type Place = {
  readonly root: string;
  readonly component: Component;
  readonly os: Os;
};

export function component(ctx: { readonly component?: Component }): Component {
  if (ctx.component === undefined) throw new EngineError('a rust check ran without a component');
  return ctx.component;
}

/** The component's directory, absolute. */
export function componentDir(place: Pick<Place, 'root' | 'component'>): string {
  return place.component.root === '.' ? place.root : join(place.root, place.component.root);
}

function prefix(root: string): string {
  let end = root.length;
  while (end > 0 && root[end - 1] === '/') end -= 1;
  return root === '.' || end === 0 ? '' : `${root.slice(0, end)}/`;
}

/** A repository-relative path made relative to the component's root, or undefined outside it. */
export function inComponent(root: string, path: string): string | undefined {
  const start = prefix(root);
  return path.startsWith(start) ? path.slice(start.length) : undefined;
}

/** A component-relative path made repository-relative. */
export function inRepo(root: string, path: string): string {
  return posix.normalize(`${prefix(root)}${path}`);
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

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
