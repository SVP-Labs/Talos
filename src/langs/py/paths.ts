import { access } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  APPLIES,
  type Applicability,
  type ApplyContext,
  type Component,
  EngineError,
  skip,
} from '../../core/check.js';
import {
  componentDir,
  componentOf,
  inComponent,
  inRepo,
  type Place,
} from '../../core/component.js';
import { underRoot } from '../../repo/facts.js';

export function component(ctx: { readonly component?: Component }): Component {
  return componentOf(ctx, 'py');
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
function venvDir(place: Pick<Place, 'root' | 'component'>): string {
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

export function hasPython(ctx: Pick<ApplyContext, 'facts' | 'component'>): Applicability {
  return pythonFiles(ctx).length > 0 ? APPLIES : skip('the component has no Python files');
}
