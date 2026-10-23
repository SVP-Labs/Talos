import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { rootOf } from './files.js';
import { TOOL_ENV, upwards } from './node.js';
import { EngineError } from '../../core/check.js';
import type { InstallContext } from '../../core/pack.js';
import type { ExecResult } from '../../exec/exec.js';

export type InstallCommand = {
  readonly lockfile: string;
  readonly command: string;
  readonly args: readonly string[];
};

/** Each package manager's lockfile and its install that never changes the lockfile. */
export const INSTALLS: readonly InstallCommand[] = [
  { lockfile: 'pnpm-lock.yaml', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
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
    let result: ExecResult;
    try {
      result = await ctx.exec(install.command, install.args, { cwd: dir, env: TOOL_ENV });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new EngineError(`${install.command} is needed to install ${root}: ${reason}`);
    }
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
