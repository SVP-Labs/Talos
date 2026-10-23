import { access } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import type { ApplyContext, Component, Os } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import { underRoot } from '../../repo/facts.js';

/** Where a component's tools are found: its checkout and the OS it runs on. */
export type Place = {
  readonly root: string;
  readonly component: Component;
  readonly os: Os;
};

export function component(ctx: { readonly component?: Component }): Component {
  if (ctx.component === undefined) throw new EngineError('a py check ran without a component');
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

/** A path a tool printed (absolute, or relative to the component) made repository-relative. */
export function fromTool(place: Pick<Place, 'root' | 'component'>, file: string): string {
  if (isAbsolute(file)) return relative(place.root, file).split(sep).join('/');
  return inRepo(place.component.root, file.split(sep).join('/').replace(/^\.\//, ''));
}

/** The component's tracked Python sources and stubs, relative to its root. */
export function pythonFiles(ctx: Pick<ApplyContext, 'facts' | 'component'>): string[] {
  const root = component(ctx).root;
  return underRoot(ctx.facts.matching('**/*.py', '**/*.pyi'), root)
    .map((file) => inComponent(root, file))
    .filter((file): file is string => file !== undefined);
}

const TEST_DIRS = new Set(['tests', 'test']);

/** Test code as pytest lays it out: a tests directory, test_*.py, *_test.py and conftest.py. */
export function isTestPath(path: string): boolean {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  if (parts.slice(0, -1).some((part) => TEST_DIRS.has(part))) return true;
  return /^test_.*\.pyi?$/.test(name) || /_test\.pyi?$/.test(name) || name === 'conftest.py';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The virtual environment `install()` creates in the component's root. */
export function venvDir(place: Pick<Place, 'root' | 'component'>): string {
  return join(componentDir(place), '.venv');
}

/** A console script from the component's virtual environment, which must be installed. */
export async function venvTool(place: Place, name: string): Promise<string> {
  const path =
    place.os === 'windows'
      ? join(venvDir(place), 'Scripts', `${name}.exe`)
      : join(venvDir(place), 'bin', name);
  if (await exists(path)) return path;
  throw new EngineError(
    `${name} is not installed in ${inRepo(place.component.root, '.venv')}: ` +
      'add it to the dev dependencies at the version Talos pins',
  );
}

export async function fileExists(path: string): Promise<boolean> {
  return exists(path);
}
