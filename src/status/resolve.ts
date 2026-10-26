import { access, readdir } from 'node:fs/promises';
import { delimiter, dirname, join, relative } from 'node:path';
import type { DevTools } from '../core/pack.js';

type Env = Readonly<Record<string, string | undefined>>;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function list(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

/** Node's resolution: `node_modules/<name>` in the component's root or a parent up to `top`. */
async function inNodeModules(name: string, root: string, top: string): Promise<boolean> {
  let directory = root;
  for (;;) {
    if (await exists(join(directory, 'node_modules', name, 'package.json'))) return true;
    const parent = dirname(directory);
    if (parent === directory || relative(top, directory) === '') return false;
    directory = parent;
  }
}

/** An installed distribution in the component's `.venv` (`<name>-<version>.dist-info`). */
async function inVirtualEnv(name: string, root: string): Promise<boolean> {
  const normalized = `${name.toLowerCase().replaceAll(/[-_.]+/g, '_')}-`;
  const sites = [join(root, '.venv', 'Lib', 'site-packages')];
  for (const entry of await list(join(root, '.venv', 'lib'))) {
    if (entry.startsWith('python')) sites.push(join(root, '.venv', 'lib', entry, 'site-packages'));
  }
  for (const site of sites) {
    const entries = await list(site);
    if (entries.some((e) => e.toLowerCase().startsWith(normalized) && e.endsWith('.dist-info'))) {
      return true;
    }
  }
  return false;
}

/** An executable on `PATH` or in one of `extra`, with Windows's extensions. */
export async function onPath(
  name: string,
  env: Env,
  extra: readonly string[] = [],
): Promise<boolean> {
  const directories = [...extra, ...(env.PATH ?? env.Path ?? '').split(delimiter)].filter(Boolean);
  const extensions = [
    '',
    ...(env.PATHEXT ?? '')
      .split(';')
      .filter(Boolean)
      .map((e) => e.toLowerCase()),
  ];
  for (const directory of directories) {
    for (const extension of extensions) {
      if (await exists(join(directory, `${name}${extension}`))) return true;
    }
  }
  return false;
}

export type ResolveContext = {
  /** The component's root, absolute. */
  readonly root: string;
  /** The repository's root, absolute: Node's lookup stops there. */
  readonly top: string;
  readonly env: Env;
  readonly home: string;
};

/** Whether one of a component's editor tools is installed where its language looks for it. */
export async function resolvable(
  manager: DevTools['manager'],
  name: string,
  ctx: ResolveContext,
): Promise<boolean> {
  switch (manager) {
    case 'npm': {
      return inNodeModules(name, ctx.root, ctx.top);
    }
    case 'pypi': {
      return (await inVirtualEnv(name, ctx.root)) || onPath(name, ctx.env);
    }
    case 'composer': {
      return exists(join(ctx.root, 'vendor', name, 'composer.json'));
    }
    case 'cargo': {
      return onPath(name, ctx.env, [join(ctx.home, '.cargo', 'bin')]);
    }
    case 'luarocks': {
      return onPath(name, ctx.env, [join(ctx.root, 'lua_modules', 'bin')]);
    }
  }
}

/** The tools of `devTools` that can't be found. */
export async function missingTools(devTools: DevTools, ctx: ResolveContext): Promise<string[]> {
  const names = Object.keys(devTools.packages);
  const found = await Promise.all(names.map((name) => resolvable(devTools.manager, name, ctx)));
  return names.filter((_, index) => found[index] !== true);
}
