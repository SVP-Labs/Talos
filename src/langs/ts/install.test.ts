import { describe, expect, it } from 'vitest';
import { installFor, installTs } from './install.js';
import { parseConfig } from '../../config/load.js';
import { EngineError } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { Exec } from '../../exec/exec.js';
import { MINIMAL_CONFIG, noTools, tempRepo } from '../../testing/engine.js';

describe('installFor', () => {
  it('picks the package manager by lockfile', () => {
    expect(installFor(new Set(['pnpm-lock.yaml']))).toMatchObject({
      command: 'pnpm',
      args: ['install', '--frozen-lockfile'],
    });
    expect(installFor(new Set(['package-lock.json']))).toMatchObject({
      command: 'npm',
      args: ['ci'],
    });
    expect(installFor(new Set(['yarn.lock']))).toMatchObject({
      command: 'yarn',
      args: ['install', '--immutable'],
    });
    expect(installFor(new Set())).toBeUndefined();
  });
});

describe('installTs', () => {
  const config = parseConfig(MINIMAL_CONFIG);

  function recorder(code = 0): { exec: Exec; calls: { command: string; cwd: string }[] } {
    const calls: { command: string; cwd: string }[] = [];
    const exec: Exec = (command, _args, options) => {
      calls.push({ command, cwd: options.cwd });
      return Promise.resolve({
        code,
        stdout: '',
        stderr: code === 0 ? '' : 'ERR_PNPM_OUTDATED_LOCKFILE',
      });
    };
    return { exec, calls };
  }

  it("installs from the workspace's lockfile above the component", async () => {
    const root = await tempRepo({ 'pnpm-lock.yaml': '', 'apps/web/package.json': '{}' });
    const { exec, calls } = recorder();
    const component = { lang: 'ts' as const, root: 'apps/web', os: ['linux' as const] };
    await installTs({
      root,
      component,
      config,
      exec,
      tools: noTools,
      log: silentLogger,
      os: 'linux',
    });
    expect(calls).toEqual([{ command: 'pnpm', cwd: root }]);
  });

  it('is an engine error without a lockfile, or when the install fails', async () => {
    const component = { lang: 'ts' as const, root: '.', os: ['linux' as const] };
    const bare = await tempRepo({ 'package.json': '{}' });
    const base = { component, config, tools: noTools, log: silentLogger, os: 'linux' as const };
    await expect(installTs({ ...base, root: bare, exec: recorder().exec })).rejects.toThrow(
      /no pnpm-lock\.yaml, package-lock\.json or yarn\.lock/,
    );
    const locked = await tempRepo({ 'package-lock.json': '{}' });
    await expect(installTs({ ...base, root: locked, exec: recorder(1).exec })).rejects.toThrow(
      EngineError,
    );
  });
});
