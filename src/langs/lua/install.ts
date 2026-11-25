import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVTOOLS_ROCKSPEC,
  devtoolsLock,
  devtoolsRockspec,
  LUA_VERSION,
  LUAROCKS_VERSION,
} from './devtools.js';
import { componentDir, fileExists, inRepo, TREE, treeDir, treeProgram } from './paths.js';
import { cachedSource, LUA_SOURCE, type LuaSource, toolCache } from './source.js';
import { EngineError } from '../../core/check.js';
import type { InstallContext } from '../../core/pack.js';
import type { ExecResult } from '../../exec/exec.js';

const HOUR = 60 * 60 * 1000;

/** The rockspecs in a directory, sorted. */
export function rockspecs(names: readonly string[]): string[] {
  return names.filter((name) => name.endsWith('.rockspec')).sort((a, b) => a.localeCompare(b));
}

/**
 * The arguments for hererocks: Lua and LuaRocks at Talos's versions, without readline. hererocks
 * takes an archive it finds in `downloads` instead of fetching it, after checking its checksum.
 */
export function hererocksArgs(script: string, tree: string, downloads: string): string[] {
  return [
    'run',
    '--no-project',
    '--no-config',
    script,
    tree,
    '--lua',
    LUA_VERSION,
    '--luarocks',
    LUAROCKS_VERSION,
    '--no-readline',
    '--downloads',
    downloads,
  ];
}

function detail(result: ExecResult): string {
  return `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-15).join('\n');
}

async function run(
  ctx: InstallContext,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  const result = await ctx.exec(command, args, { cwd, timeoutMs: HOUR });
  if (result.code !== 0) {
    const where = inRepo(ctx.component.root, '.');
    throw new EngineError(`${args.join(' ')} failed in ${where}:\n${detail(result)}`);
  }
}

/** Lua's source tarball and the tool cache it is kept in. */
export type LuaFetch = { readonly source: LuaSource; readonly cache: string };

/**
 * Builds Lua and LuaRocks into the tree with hererocks, which `tools.lock` pins, from the cached
 * copy of Lua's source tarball. hererocks gets a copy in a directory of its own: it writes the
 * LuaRocks archive there too, and a half-written one must never land in the shared cache.
 */
async function buildTree(ctx: InstallContext, lua: LuaFetch): Promise<void> {
  const [uv, hererocks] = await Promise.all([ctx.tools.path('uv'), ctx.tools.path('hererocks')]);
  const tarball = await cachedSource(ctx, lua.source, lua.cache);
  const downloads = await mkdtemp(join(tmpdir(), 'talos-lua-'));
  try {
    await copyFile(tarball, join(downloads, lua.source.file));
    await run(ctx, uv, hererocksArgs(hererocks, treeDir(ctx), downloads), componentDir(ctx));
  } finally {
    await rm(downloads, { recursive: true, force: true });
  }
}

/** The dev tools and everything they need, from Talos's lockfile, into the tree. */
async function installDevTools(ctx: InstallContext, luarocks: string): Promise<void> {
  const dir = join(treeDir(ctx), 'talos');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, DEVTOOLS_ROCKSPEC), devtoolsRockspec());
  await writeFile(join(dir, 'luarocks.lock'), devtoolsLock());
  const args = ['--tree', treeDir(ctx), 'make', '--deps-only', DEVTOOLS_ROCKSPEC];
  await run(ctx, luarocks, args, dir);
}

/** The project's own dependencies, from its rockspec and the lockfile beside it. */
async function installProject(ctx: InstallContext, luarocks: string): Promise<void> {
  const dir = componentDir(ctx);
  const found = rockspecs(await readdir(dir));
  const [rockspec, ...others] = found;
  if (rockspec === undefined) return;
  const where = inRepo(ctx.component.root, '.');
  if (others.length > 0) {
    throw new EngineError(
      `${where} has ${found.join(', ')}: keep one rockspec in the component's root, ` +
        'and older versions elsewhere',
    );
  }
  if (!(await fileExists(join(dir, 'luarocks.lock')))) {
    throw new EngineError(
      `${where} has ${rockspec} but no luarocks.lock: Talos installs Lua dependencies only from ` +
        `a lockfile; write it with "luarocks make --pin --deps-only ${rockspec}"`,
    );
  }
  await run(ctx, luarocks, ['--tree', treeDir(ctx), 'make', '--deps-only', rockspec], dir);
}

/**
 * Builds the component's tree in `.lua` in its root: Lua and LuaRocks, the dev tools from
 * Talos's lockfile, then the project's rockspec dependencies from its own. The project's come
 * last, so where they want another version of a tool, they win and `lua/toolchain` says so.
 */
export async function install(
  ctx: InstallContext,
  lua: LuaFetch = { source: LUA_SOURCE, cache: toolCache() },
): Promise<void> {
  ctx.log.debug(`${inRepo(ctx.component.root, TREE)}: Lua ${LUA_VERSION}`);
  await buildTree(ctx, lua);
  const luarocks = treeProgram(ctx, 'luarocks');
  await installDevTools(ctx, luarocks);
  await installProject(ctx, luarocks);
}
