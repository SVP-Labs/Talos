import { join } from 'node:path';
import { componentDir, fileExists, inRepo } from './paths.js';
import { requireNewestPhp } from './runtime.js';
import { EngineError } from '../../core/check.js';
import type { InstallContext } from '../../core/pack.js';
import { ExecError, type ExecResult } from '../../exec/exec.js';

const HOUR = 60 * 60 * 1000;

const COMPOSER_INSTALL = [
  'install',
  '--no-interaction',
  '--no-progress',
  '--prefer-dist',
  '--no-ansi',
];

/**
 * Composer runs plugins and scripts as root only when this is set. The gate runs the project's
 * code anyway (its tests), and Pest and Infection need their plugins, so a root container gets
 * what an ordinary runner gets.
 */
const ENV: Readonly<Record<string, string>> = {
  COMPOSER_ALLOW_SUPERUSER: '1',
  COMPOSER_NO_INTERACTION: '1',
  NO_COLOR: '1',
};

function detail(result: ExecResult): string {
  return `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-15).join('\n');
}

/**
 * Installs a component's dependencies into `vendor/` with Composer, only ever from composer.lock,
 * dev dependencies included, since the checks run the dev tools; never on a PHP that isn't the
 * newest release of its cycle.
 */
export async function install(ctx: InstallContext): Promise<void> {
  const dir = componentDir(ctx);
  const where = inRepo(ctx.component.root, '.');
  if (!(await fileExists(join(dir, 'composer.lock')))) {
    throw new EngineError(
      `${where} has no composer.lock: Talos installs PHP dependencies only from a lockfile`,
    );
  }
  await requireNewestPhp(ctx.exec, dir);
  let result: ExecResult;
  try {
    result = await ctx.exec('composer', COMPOSER_INSTALL, { cwd: dir, env: ENV, timeoutMs: HOUR });
  } catch (error) {
    if (!(error instanceof ExecError)) throw error;
    throw new EngineError(`composer is needed to install ${where}: ${error.message}`);
  }
  if (result.code !== 0) {
    throw new EngineError(`composer install failed in ${where}:\n${detail(result)}`);
  }
}
