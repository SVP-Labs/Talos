import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEVTOOLS_ROCKSPEC,
  devtoolsLock,
  devtoolsRockspec,
  LUA_VERSION,
  LUAROCKS_VERSION,
} from './devtools.js';
import { componentDir, fileExists, inRepo, TREE, treeDir, treeProgram } from './paths.js';
import { EngineError } from '../../core/check.js';
import type { InstallContext } from '../../core/pack.js';
import type { ExecResult } from '../../exec/exec.js';

const HOUR = 60 * 60 * 1000;

/** The rockspecs in a directory, sorted. */
export function rockspecs(names: readonly string[]): string[] {
  return names.filter((name) => name.endsWith('.rockspec')).sort((a, b) => a.localeCompare(b));
}

/** The arguments for hererocks: Lua and LuaRocks at Talos's versions, without readline. */
export function hererocksArgs(script: string, tree: string): string[] {
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

/** Builds Lua and LuaRocks into the tree with hererocks, which `tools.lock` pins. */
async function buildTree(ctx: InstallContext): Promise<void> {
  const [uv, hererocks] = await Promise.all([ctx.tools.path('uv'), ctx.tools.path('hererocks')]);
  await run(ctx, uv, hererocksArgs(hererocks, treeDir(ctx)), componentDir(ctx));
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
export async function install(ctx: InstallContext): Promise<void> {
  ctx.log.debug(`${inRepo(ctx.component.root, TREE)}: Lua ${LUA_VERSION}`);
  await buildTree(ctx);
  const luarocks = treeProgram(ctx, 'luarocks');
  await installDevTools(ctx, luarocks);
  await installProject(ctx, luarocks);
}
