import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { install } from './install.js';
import { parseConfig } from '../../config/load.js';
import { EngineError } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { InstallContext } from '../../core/pack.js';
import { type Exec, ExecError, type ExecResult } from '../../exec/exec.js';
import { MINIMAL_CONFIG, noTools, tempRepo } from '../../testing/engine.js';

type Call = { readonly line: string; readonly cwd: string };

/** rustup and cargo as they answer, recording each call as one command line. */
function recorder(answer: (line: string) => ExecResult | Error): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = (command, args, options) => {
    const line = [command, ...args].join(' ');
    calls.push({ line, cwd: options.cwd });
    const result = answer(line);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  return { exec, calls };
}

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };

async function contextFor(
  files: Readonly<Record<string, string>>,
  exec: Exec,
): Promise<InstallContext> {
  return {
    root: await tempRepo(files),
    component: { lang: 'rust', root: 'crates/app', os: ['linux'] },
    config: parseConfig(MINIMAL_CONFIG),
    exec,
    tools: noTools,
    log: silentLogger,
    os: 'linux',
  };
}

const LOCKED = {
  'crates/app/Cargo.toml': '[package]\nname = "app"\n',
  'crates/app/Cargo.lock': '',
};

describe('rust install', () => {
  it('installs the pinned toolchain and its components, then fetches the locked crates', async () => {
    const { exec, calls } = recorder(() => OK);
    const ctx = await contextFor(
      { ...LOCKED, 'rust-toolchain.toml': '[toolchain]\nchannel = "1.97.0"\n' },
      exec,
    );
    await install(ctx);
    expect(calls.map((c) => c.line)).toEqual([
      'rustup --version',
      'rustup toolchain install',
      'rustup component add clippy rustfmt llvm-tools',
      'cargo fetch --locked',
    ]);
    expect(new Set(calls.map((c) => c.cwd))).toEqual(new Set([join(ctx.root, 'crates/app')]));
  });

  it('adds the components to the default toolchain when nothing pins one', async () => {
    const { exec, calls } = recorder(() => OK);
    await install(await contextFor(LOCKED, exec));
    expect(calls.map((c) => c.line)).toEqual([
      'rustup --version',
      'rustup component add clippy rustfmt llvm-tools',
      'cargo fetch --locked',
    ]);
  });

  it('only fetches with a Rust that has no rustup', async () => {
    const { exec, calls } = recorder((line) =>
      line.startsWith('rustup') ? new ExecError('spawn rustup ENOENT') : OK,
    );
    await install(await contextFor({ ...LOCKED, 'crates/rust-toolchain': '1.97.0\n' }, exec));
    expect(calls.map((c) => c.line)).toEqual(['rustup --version', 'cargo fetch --locked']);
  });

  it('refuses a component without a Cargo.lock', async () => {
    const { exec, calls } = recorder(() => OK);
    const ctx = await contextFor({ 'crates/app/Cargo.toml': '' }, exec);
    await expect(install(ctx)).rejects.toThrow(
      new EngineError(
        'crates/app has no Cargo.lock: Talos installs Rust dependencies only from a lockfile',
      ),
    );
    expect(calls).toEqual([]);
  });

  it('says which step failed, where, and what the tool printed', async () => {
    const { exec } = recorder((line) =>
      line.startsWith('cargo')
        ? { code: 101, stdout: '', stderr: 'error: lock file needs to be updated' }
        : OK,
    );
    await expect(install(await contextFor(LOCKED, exec))).rejects.toThrow(
      'cargo fetch --locked failed in crates/app:\nerror: lock file needs to be updated',
    );
  });

  it('passes on anything but a missing rustup', async () => {
    const { exec } = recorder(() => new TypeError('bad arguments'));
    await expect(install(await contextFor(LOCKED, exec))).rejects.toThrow(TypeError);
  });
});
