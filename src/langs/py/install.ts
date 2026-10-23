import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tail } from './run.js';
import { EngineError } from '../../core/check.js';
import { componentDir, fileExists, inRepo } from '../../core/component.js';
import type { InstallContext } from '../../core/pack.js';

const HOUR = 60 * 60 * 1000;

/** `requirements*.txt` files in a directory, sorted. */
export function requirementFiles(names: readonly string[]): string[] {
  return names
    .filter((name) => /^requirements[\w.-]*\.txt$/.test(name))
    .sort((a, b) => a.localeCompare(b));
}

async function uv(ctx: InstallContext, args: readonly string[]): Promise<void> {
  const tool = await ctx.tools.path('uv');
  const result = await ctx.exec(tool, ['--no-progress', ...args], {
    cwd: componentDir(ctx),
    timeoutMs: HOUR,
  });
  if (result.code !== 0) {
    throw new EngineError(
      `uv ${args.join(' ')} failed in ${inRepo(ctx.component.root, '.')}:\n${tail(result)}`,
    );
  }
}

/**
 * Installs a component's dependencies into `.venv` in its root, only ever from a lock: a
 * uv.lock as locked (every group, since the checks need the dev tools), or hashed
 * requirements files, which uv refuses unless every requirement is pinned with a hash.
 */
export async function install(ctx: InstallContext): Promise<void> {
  const dir = componentDir(ctx);
  if (await fileExists(join(dir, 'uv.lock'))) {
    await uv(ctx, ['sync', '--frozen', '--all-groups']);
    return;
  }
  const requirements = requirementFiles(await readdir(dir));
  if (requirements.length === 0) {
    throw new EngineError(
      `${inRepo(ctx.component.root, '.')} has no uv.lock and no requirements*.txt: ` +
        'Talos installs Python dependencies only from a lockfile',
    );
  }
  await uv(ctx, ['venv', '--allow-existing', '.venv']);
  await uv(ctx, [
    'pip',
    'install',
    '--python',
    '.venv',
    '--require-hashes',
    ...requirements.flatMap((file) => ['-r', file]),
  ]);
}
