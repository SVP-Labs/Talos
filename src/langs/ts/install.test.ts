import { describe, expect, it } from 'vitest';
import { installFor, installTs } from './install.js';
import { parseConfig } from '../../config/load.js';
import { EngineError } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import { ExecError, type Exec } from '../../exec/exec.js';
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

  describe('without pnpm on PATH', () => {
    const component = { lang: 'ts' as const, root: '.', os: ['linux' as const] };
    const base = { component, config, tools: noTools, log: silentLogger, os: 'linux' as const };

    type Call = { command: string; args: readonly string[]; env: Record<string, unknown> };

    /** An exec on which the programs in `missing` can't start, as spawn reports ENOENT. */
    function onPath(missing: readonly string[]): { exec: Exec; calls: Call[] } {
      const calls: Call[] = [];
      const exec: Exec = (command, args, options) => {
        calls.push({ command, args, env: { ...options.env } });
        if (missing.includes(command)) {
          return Promise.reject(
            new ExecError(`${command} could not start: spawn ${command} ENOENT`),
          );
        }
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      };
      return { exec, calls };
    }

    const corepackEnv = {
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      COREPACK_DEFAULT_TO_LATEST: '0',
      COREPACK_ENABLE_AUTO_PIN: '0',
    };

    it('runs pnpm itself when it is there, never Corepack', async () => {
      const root = await tempRepo({ 'pnpm-lock.yaml': '' });
      const { exec, calls } = onPath([]);
      await installTs({ ...base, root, exec });
      expect(calls.map((c) => [c.command, ...c.args])).toEqual([
        ['pnpm', 'install', '--frozen-lockfile'],
      ]);
      expect(Object.keys(calls[0]?.env ?? {})).not.toContain('COREPACK_ENABLE_AUTO_PIN');
    });

    it("installs through Corepack's pnpm, which never prompts or pins", async () => {
      const root = await tempRepo({ 'pnpm-lock.yaml': '' });
      const { exec, calls } = onPath(['pnpm']);
      await installTs({ ...base, root, exec });
      expect(calls.map((c) => [c.command, ...c.args])).toEqual([
        ['pnpm', 'install', '--frozen-lockfile'],
        ['corepack', 'pnpm', 'install', '--frozen-lockfile'],
      ]);
      expect(calls[1]?.env).toMatchObject({ ...corepackEnv, CI: 'true' });
    });

    it('is an engine error naming both when Corepack is missing too', async () => {
      const root = await tempRepo({ 'pnpm-lock.yaml': '' });
      const { exec } = onPath(['pnpm', 'corepack']);
      const install = installTs({ ...base, root, exec });
      await expect(install).rejects.toThrow(EngineError);
      await expect(install).rejects.toThrow(
        /pnpm or corepack is needed to install \.: pnpm could not start: .*; corepack could not start/,
      );
    });

    it("falls back only when pnpm can't start, not when it times out", async () => {
      const root = await tempRepo({ 'pnpm-lock.yaml': '' });
      const calls: string[] = [];
      const exec: Exec = (command) => {
        calls.push(command);
        return Promise.reject(new ExecError(`${command} timed out after 1800000 ms`));
      };
      await expect(installTs({ ...base, root, exec })).rejects.toThrow(
        /pnpm is needed to install \.: pnpm timed out/,
      );
      expect(calls).toEqual(['pnpm']);
    });

    it('keeps npm and yarn failing as they did when they cannot start', async () => {
      for (const [lockfile, command] of [
        ['package-lock.json', 'npm'],
        ['yarn.lock', 'yarn'],
      ] as const) {
        const root = await tempRepo({ [lockfile]: '' });
        const { exec, calls } = onPath([command]);
        await expect(installTs({ ...base, root, exec })).rejects.toThrow(
          new RegExp(`^${command} is needed to install \\.: ${command} could not start`),
        );
        expect(calls.map((c) => c.command)).toEqual([command]);
      }
    });
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
