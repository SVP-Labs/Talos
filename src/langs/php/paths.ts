import { access } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { type ApplyContext, type Component, EngineError, type Os } from '../../core/check.js';
import { underRoot } from '../../repo/facts.js';

/** A component in a checkout (`root`, absolute), on the OS the check runs on. */
export type Place = {
  readonly component: Component;
  readonly os: Os;
  readonly root: string;
};

/** The component a check runs for, which the engine sets for every component check. */
export function component(ctx: { readonly component?: Component }): Component {
  const found = ctx.component;
  if (found !== undefined) return found;
  throw new EngineError('a PHP check ran with no component');
}

/** The component's directory, absolute. */
export function componentDir(place: Pick<Place, 'root' | 'component'>): string {
  return resolve(place.root, place.component.root);
}

/** A component's root as `talos.yml` may write it, normalised: no trailing slash, `.` for none. */
function rootOf(root: string): string {
  const normal = posix.normalize(`${root}/`);
  return normal === './' || normal === '/' ? '.' : normal.slice(0, -1);
}

/** A repository-relative path made relative to the component's root, or undefined outside it. */
export function inComponent(root: string, path: string): string | undefined {
  const base = rootOf(root);
  if (base === '.') return path;
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined;
}

/** A component-relative path made repository-relative. */
export function inRepo(root: string, path: string): string {
  return posix.join(rootOf(root), path);
}

/** A path a tool printed (absolute, or relative to the component) made repository-relative. */
export function fromTool(place: Pick<Place, 'root' | 'component'>, file: string): string {
  const repo = isAbsolute(file) ? relative(place.root, file) : file;
  const posixPath = repo.replaceAll('\\', '/');
  return isAbsolute(file) ? posixPath : inRepo(place.component.root, posixPath);
}

/** A component-relative path made absolute. */
export function absolute(place: Pick<Place, 'root' | 'component'>, path: string): string {
  return join(componentDir(place), ...path.split('/'));
}

/** PHP that Talos checks: no Blade template (Blade is not PHP) and nothing Composer installed. */
export function isCheckedPhp(path: string): boolean {
  return path.endsWith('.php') && !path.endsWith('.blade.php') && !path.startsWith('vendor/');
}

/** The component's tracked PHP sources, relative to its root. */
export function phpFiles(ctx: Pick<ApplyContext, 'facts' | 'component'>): string[] {
  const root = component(ctx).root;
  return underRoot(ctx.facts.matching('**/*.php'), root)
    .map((file) => inComponent(root, file))
    .filter((file): file is string => file !== undefined && isCheckedPhp(file));
}

const TEST_DIRS = new Set(['tests', 'test']);

/** Test code as PHPUnit and Pest lay it out: a tests directory, or a file named `*Test.php`. */
export function isTestPath(path: string): boolean {
  const parts = path.split('/');
  if (parts.slice(0, -1).some((part) => TEST_DIRS.has(part))) return true;
  return (parts.at(-1) ?? '').endsWith('Test.php');
}

/** The component's shipped PHP, relative to its root: everything that isn't test code. */
export function shippedFiles(ctx: Pick<ApplyContext, 'facts' | 'component'>): string[] {
  return phpFiles(ctx).filter((file) => !isTestPath(file));
}

/** Whether the component tracks a file at this component-relative path. */
export function tracks(ctx: Pick<ApplyContext, 'facts' | 'component'>, path: string): boolean {
  return ctx.facts.files.includes(inRepo(component(ctx).root, path));
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
