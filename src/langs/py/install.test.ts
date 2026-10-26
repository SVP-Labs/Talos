import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { install, requirementFiles } from './install.js';
import { parseConfig } from '../../config/load.js';
import { EngineError } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { InstallContext } from '../../core/pack.js';
import type { Exec } from '../../exec/exec.js';
import { tempRepo } from '../../testing/engine.js';

type Call = { command: string; args: readonly string[]; cwd: string };

function context(root: string, code = 0): { ctx: InstallContext; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return Promise.resolve({
      code,
      stdout: '',
      stderr: code === 0 ? '' : 'error: resolution failed',
    });
  };
  const ctx: InstallContext = {
    root,
    component: { lang: 'py', root: 'svc', os: ['linux'] },
    config: parseConfig('name: T\nprefix: T\n'),
    exec,
    tools: { path: (name) => Promise.resolve(`/tools/${name}`), version: () => '0.11.0' },
    log: silentLogger,
    os: 'linux',
  };
  return { ctx, calls };
}

describe('requirementFiles', () => {
  it('picks requirements*.txt files in a stable order', () => {
    expect(
      requirementFiles([
        'requirements-dev.txt',
        'README.md',
        'requirements.txt',
        'constraints.txt',
      ]),
    ).toEqual(['requirements-dev.txt', 'requirements.txt']);
  });
});

describe('install', () => {
  it('syncs a uv.lock as locked, with every group', async () => {
    const root = await tempRepo({ 'svc/uv.lock': '', 'svc/requirements.txt': '' });
    const { ctx, calls } = context(root);
    await install(ctx);
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ['/tools/uv', '--no-progress', 'sync', '--frozen', '--all-groups'],
    ]);
    expect(calls[0]?.cwd).toBe(join(root, 'svc'));
  });

  it('installs hashed requirements into a virtual environment', async () => {
    const root = await tempRepo({ 'svc/requirements.txt': '', 'svc/requirements-dev.txt': '' });
    const { ctx, calls } = context(root);
    await install(ctx);
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      '--no-progress venv --allow-existing .venv',
      '--no-progress pip install --python .venv --require-hashes ' +
        '-r requirements-dev.txt -r requirements.txt',
    ]);
  });

  it('refuses a component with no lock, and reports a failed install', async () => {
    const bare = await tempRepo({ 'svc/pyproject.toml': '' });
    await expect(install(context(bare).ctx)).rejects.toThrow(EngineError);
    const locked = await tempRepo({ 'svc/uv.lock': '' });
    await expect(install(context(locked, 2).ctx)).rejects.toThrow(/resolution failed/);
  });
});
