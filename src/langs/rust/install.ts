import { dirname, join, relative } from 'node:path';
import { HOUR, runIn, tail } from './run.js';
import { EngineError } from '../../core/check.js';
import { componentDir, fileExists, inRepo } from '../../core/component.js';
import type { InstallContext } from '../../core/pack.js';
import { ExecError } from '../../exec/exec.js';

/** What the checks need beside the compiler: Clippy, rustfmt, and LLVM's tools for coverage. */
const GATE_COMPONENTS = ['clippy', 'rustfmt', 'llvm-tools'];

async function step(ctx: InstallContext, command: string, args: readonly string[]): Promise<void> {
  const result = await runIn(ctx, command, args, { timeoutMs: HOUR });
  if (result.code !== 0) {
    throw new EngineError(
      `${command} ${args.join(' ')} failed in ${inRepo(ctx.component.root, '.')}:\n${tail(result)}`,
    );
  }
}

/** rustup, when the machine has it: a Rust from a distribution's packages has no rustup. */
async function hasRustup(ctx: InstallContext): Promise<boolean> {
  try {
    return (await runIn(ctx, 'rustup', ['--version'])).code === 0;
  } catch (error) {
    if (error instanceof ExecError) return false;
    throw error;
  }
}

/** Whether a toolchain file in the component's directory or above it, in the checkout, pins one. */
async function pinned(ctx: InstallContext): Promise<boolean> {
  let dir = componentDir(ctx);
  for (;;) {
    for (const name of ['rust-toolchain.toml', 'rust-toolchain']) {
      if (await fileExists(join(dir, name))) return true;
    }
    if (relative(ctx.root, dir) === '' || dirname(dir) === dir) return false;
    dir = dirname(dir);
  }
}

/**
 * Installs the toolchain the component pins (rustup reads its rust-toolchain.toml) with the
 * components the checks use, then fetches the crates its Cargo.lock names, only ever as
 * locked: a component without a Cargo.lock can't be installed.
 */
export async function install(ctx: InstallContext): Promise<void> {
  const dir = componentDir(ctx);
  if (!(await fileExists(join(dir, 'Cargo.lock')))) {
    throw new EngineError(
      `${inRepo(ctx.component.root, '.')} has no Cargo.lock: ` +
        'Talos installs Rust dependencies only from a lockfile',
    );
  }
  if (await hasRustup(ctx)) {
    if (await pinned(ctx)) await step(ctx, 'rustup', ['toolchain', 'install']);
    await step(ctx, 'rustup', ['component', 'add', ...GATE_COMPONENTS]);
  }
  await step(ctx, 'cargo', ['fetch', '--locked']);
}
