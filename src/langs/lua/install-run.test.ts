import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVTOOLS_ROCKSPEC } from './devtools.js';
import { install } from './install.js';
import { parseConfig } from '../../config/load.js';
import { EngineError, type Os } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { InstallContext } from '../../core/pack.js';
import type { Exec, ExecResult } from '../../exec/exec.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

type Call = { readonly command: string; readonly args: readonly string[]; readonly cwd: string };

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };

async function setup(
  files: Readonly<Record<string, string>>,
  answer: (call: Call) => ExecResult = () => OK,
  os: Os = 'linux',
): Promise<{ ctx: InstallContext; calls: Call[] }> {
  const calls: Call[] = [];
  const exec: Exec = (command, args, options) => {
    const call = { command, args, cwd: options.cwd };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  const ctx: InstallContext = {
    root: await tempRepo(files),
    component: { lang: 'lua', root: 'game', os: ['linux'] },
    config: parseConfig(MINIMAL_CONFIG),
    exec,
    tools: { path: (name) => Promise.resolve(`/tools/${name}`), version: () => '1.0.0' },
    log: silentLogger,
    os,
  };
  return { ctx, calls };
}

const PROJECT = {
  'game/game-1.0-1.rockspec': 'package = "game"\n',
  'game/luarocks.lock': 'return {}\n',
};

describe('lua install', () => {
  it("builds the tree, installs Talos's dev tools, then the project's locked dependencies", async () => {
    const { ctx, calls } = await setup(PROJECT);
    await install(ctx);
    const dir = join(ctx.root, 'game');
    const tree = join(dir, '.lua');
    const luarocks = join(tree, 'bin', 'luarocks');
    expect(calls.map((c) => [c.command, c.args.slice(0, 3), c.cwd])).toEqual([
      ['/tools/uv', ['run', '--no-project', '--no-config'], dir],
      [luarocks, ['--tree', tree, 'make'], join(tree, 'talos')],
      [luarocks, ['--tree', tree, 'make'], dir],
    ]);
    expect(calls[1]?.args.at(-1)).toBe(DEVTOOLS_ROCKSPEC);
    expect(calls[2]?.args.at(-1)).toBe('game-1.0-1.rockspec');
    expect(await readFile(join(tree, 'talos', DEVTOOLS_ROCKSPEC), 'utf8')).toContain(
      'dependencies',
    );
    expect(await readFile(join(tree, 'talos', 'luarocks.lock'), 'utf8')).toContain('return');
  });

  it("installs only the dev tools for a component without a rockspec, through LuaRocks' .bat on Windows", async () => {
    const { ctx, calls } = await setup({ 'game/main.lua': 'print(1)\n' }, () => OK, 'windows');
    await install(ctx);
    expect(calls.map((c) => c.command)).toEqual([
      '/tools/uv',
      join(ctx.root, 'game', '.lua', 'bin', 'luarocks.bat'),
    ]);
  });

  it('refuses more than one rockspec, or a rockspec without its lockfile', async () => {
    const two = await setup({ ...PROJECT, 'game/game-0.9-1.rockspec': '' });
    await expect(install(two.ctx)).rejects.toThrow(
      new EngineError(
        'game has game-0.9-1.rockspec, game-1.0-1.rockspec: keep one rockspec in the ' +
          "component's root, and older versions elsewhere",
      ),
    );
    const unlocked = await setup({ 'game/game-1.0-1.rockspec': '' });
    await expect(install(unlocked.ctx)).rejects.toThrow(
      'game has game-1.0-1.rockspec but no luarocks.lock',
    );
  });

  it('says which step failed, where, and what it printed', async () => {
    const failing = (call: Call): ExecResult =>
      call.command === '/tools/uv'
        ? { code: 1, stdout: 'building Lua', stderr: 'make: cc: not found' }
        : OK;
    const { ctx } = await setup(PROJECT, failing);
    await expect(install(ctx)).rejects.toThrow(
      /failed in game:\nmake: cc: not found\nbuilding Lua$/,
    );
  });
});
