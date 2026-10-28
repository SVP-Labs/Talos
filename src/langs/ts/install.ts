import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { rootOf } from './files.js';
import { TOOL_ENV, upwards } from './node.js';
import { EngineError } from '../../core/check.js';
import type { InstallContext } from '../../core/pack.js';
import { ExecError, type ExecResult } from '../../exec/exec.js';

/**
 * Corepack, which comes with Node 22, without a prompt, without the newest release in place of
 * the one Node ships, and without writing `packageManager` into `package.json`.
 */
const COREPACK_ENV: Readonly<Record<string, string>> = {
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  COREPACK_DEFAULT_TO_LATEST: '0',
  COREPACK_ENABLE_AUTO_PIN: '0',
};

type Invocation = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

export type InstallCommand = {
  readonly lockfile: string;
  readonly command: string;
  readonly args: readonly string[];
  /** What runs instead when `command` can't start, as where it isn't on `PATH`. */
  readonly fallback?: Invocation;
};

const PNPM_INSTALL = ['install', '--frozen-lockfile'];

/** Each package manager's lockfile and its install that never changes the lockfile. */
const INSTALLS: readonly InstallCommand[] = [
  {
    lockfile: 'pnpm-lock.yaml',
    command: 'pnpm',
    args: PNPM_INSTALL,
    fallback: {
      command: 'corepack',
      args: ['pnpm', ...PNPM_INSTALL],
      env: { ...TOOL_ENV, ...COREPACK_ENV },
    },
  },
  { lockfile: 'package-lock.json', command: 'npm', args: ['ci'] },
  { lockfile: 'yarn.lock', command: 'yarn', args: ['install', '--immutable'] },
];

/** The install for the first lockfile among `present` (names in one directory), if any. */
export function installFor(present: ReadonlySet<string>): InstallCommand | undefined {
  return INSTALLS.find((install) => present.has(install.lockfile));
}

async function lockFilesIn(dir: string): Promise<Set<string>> {
  const found = await Promise.all(
    INSTALLS.map((install) =>
      access(join(dir, install.lockfile)).then(
        () => install.lockfile,
        () => undefined,
      ),
    ),
  );
  return new Set(found.filter((name) => name !== undefined));
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function couldNotStart(error: unknown): boolean {
  return error instanceof ExecError && error.message.includes(' could not start: ');
}

/** Runs the install, or its fallback when the package manager can't start. */
async function runInstall(
  ctx: InstallContext,
  install: InstallCommand,
  dir: string,
  root: string,
): Promise<ExecResult> {
  try {
    return await ctx.exec(install.command, install.args, { cwd: dir, env: TOOL_ENV });
  } catch (error) {
    const { fallback } = install;
    if (fallback === undefined || !couldNotStart(error)) {
      throw new EngineError(`${install.command} is needed to install ${root}: ${reasonOf(error)}`);
    }
    ctx.log.debug(`${root}: ${fallback.command} ${fallback.args.join(' ')}`);
    try {
      return await ctx.exec(fallback.command, fallback.args, { cwd: dir, env: fallback.env });
    } catch (fallbackError) {
      throw new EngineError(
        `${install.command} or ${fallback.command} is needed to install ${root}: ` +
          `${reasonOf(error)}; ${reasonOf(fallbackError)}`,
      );
    }
  }
}

/**
 * Installs a TypeScript component's dependencies with the package manager its lockfile names,
 * looking from the component's root up to the repository's (a workspace keeps one lockfile).
 */
export async function installTs(ctx: InstallContext): Promise<void> {
  const root = rootOf(ctx.component);
  for (const dir of upwards(resolve(ctx.root, root), resolve(ctx.root))) {
    const install = installFor(await lockFilesIn(dir));
    if (install === undefined) continue;
    ctx.log.debug(`${root}: ${install.command} ${install.args.join(' ')}`);
    const result = await runInstall(ctx, install, dir, root);
    if (result.code !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-15).join('\n');
      throw new EngineError(
        `${install.command} ${install.args.join(' ')} failed in ${root}:\n${detail}`,
      );
    }
    return;
  }
  throw new EngineError(
    `${root} has no pnpm-lock.yaml, package-lock.json or yarn.lock: commit the lockfile of the ` +
      'package manager that installs it',
  );
}
