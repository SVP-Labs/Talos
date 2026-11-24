import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVTOOLS_ROCKSPEC } from './devtools.js';
import { install, type LuaFetch } from './install.js';
import type { LuaSource } from './source.js';
import { parseConfig } from '../../config/load.js';
import { EngineError, type Os } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { InstallContext } from '../../core/pack.js';
import type { Exec, ExecResult } from '../../exec/exec.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

type Call = { readonly command: string; readonly args: readonly string[]; readonly cwd: string };

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };

const TARBALL = 'lua source\n';

const SOURCE: LuaSource = {
  version: '5.4.9',
  file: 'lua-5.4.9.tar.gz',
  sha256: createHash('sha256').update(TARBALL).digest('hex'),
  urls: ['https://lua.example/lua-5.4.9.tar.gz'],
};

/** Plays curl: writes the tarball where `--output` says. */
async function download(args: readonly string[]): Promise<ExecResult> {
  const output = args[args.indexOf('--output') + 1];
  if (output !== undefined) await writeFile(output, TARBALL);
  return OK;
}

async function setup(
  files: Readonly<Record<string, string>>,
  answer: (call: Call) => ExecResult = () => OK,
  os: Os = 'linux',
): Promise<{ ctx: InstallContext; calls: Call[]; lua: LuaFetch }> {
  const calls: Call[] = [];
  const exec: Exec = (command, args, options) => {
    const call = { command, args, cwd: options.cwd };
    if (command === 'curl') return download(args);
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
  const lua = { source: SOURCE, cache: await mkdtemp(join(tmpdir(), 'lua-cache-')) };
  return { ctx, calls, lua };
}

const PROJECT = {
  'game/game-1.0-1.rockspec': 'package = "game"\n',
  'game/luarocks.lock': 'return {}\n',
};

describe('lua install', () => {
  it("builds the tree, installs Talos's dev tools, then the project's locked dependencies", async () => {
    const { ctx, calls, lua } = await setup(PROJECT);
    await install(ctx, lua);
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
    const { ctx, calls, lua } = await setup({ 'game/main.lua': 'print(1)\n' }, () => OK, 'windows');
    await install(ctx, lua);
    expect(calls.map((c) => c.command)).toEqual([
      '/tools/uv',
      join(ctx.root, 'game', '.lua', 'bin', 'luarocks.bat'),
    ]);
  });

  it('hands hererocks the verified tarball to build Lua from, and removes it afterwards', async () => {
    let handed = '';
    let downloads = '';
    const { ctx, lua } = await setup(PROJECT, (call) => {
      if (call.command === '/tools/uv') {
        downloads = call.args[call.args.indexOf('--downloads') + 1] ?? '';
        handed = readFileSync(join(downloads, SOURCE.file), 'utf8');
      }
      return OK;
    });
    await install(ctx, lua);
    expect(handed).toBe(TARBALL);
    expect(existsSync(downloads)).toBe(false);
  });

  it('refuses more than one rockspec, or a rockspec without its lockfile', async () => {
    const two = await setup({ ...PROJECT, 'game/game-0.9-1.rockspec': '' });
    await expect(install(two.ctx, two.lua)).rejects.toThrow(
      new EngineError(
        'game has game-0.9-1.rockspec, game-1.0-1.rockspec: keep one rockspec in the ' +
          "component's root, and older versions elsewhere",
      ),
    );
    const unlocked = await setup({ 'game/game-1.0-1.rockspec': '' });
    await expect(install(unlocked.ctx, unlocked.lua)).rejects.toThrow(
      'game has game-1.0-1.rockspec but no luarocks.lock',
    );
  });

  it('says which step failed, where, and what it printed', async () => {
    const failing = (call: Call): ExecResult =>
      call.command === '/tools/uv'
        ? { code: 1, stdout: 'building Lua', stderr: 'make: cc: not found' }
        : OK;
    const { ctx, lua } = await setup(PROJECT, failing);
    await expect(install(ctx, lua)).rejects.toThrow(
      /failed in game:\nmake: cc: not found\nbuilding Lua$/,
    );
  });
});
