import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  baseRuffText,
  PYRIGHT_BASE,
  pyrightConfigFile,
  RUFF_BASE,
  ruffConfigFile,
} from './configs.js';
import { pythonFiles } from './paths.js';
import { resolvePyright, weakerComments, weakerPyright } from './pyright-config.js';
import {
  parseRuffSettings,
  type RuffSettings,
  weakerRuff,
  type Weakening,
} from './ruff-settings.js';
import { type Bound, failed, runTool } from './run.js';
import { EngineError } from '../../core/check.js';
import { componentDir, inRepo } from '../../core/component.js';
import type { Finding } from '../../core/finding.js';

function weaker(ctx: Bound, file: string, base: string, w: Weakening): Finding {
  const where = inRepo(ctx.component.root, file);
  return {
    rule: 'config/weaker',
    message: `${where} ${w.message}, which is weaker than ${base}.`,
    key: `${where} ${w.setting}`,
  };
}

async function showSettings(ctx: Bound, config: string, file: string): Promise<RuffSettings> {
  const args = ['check', '--show-settings', '--no-cache', '--config', config, file];
  const result = await runTool(ctx, 'ruff', args);
  if (result.code !== 0) throw failed('ruff check --show-settings', result);
  return parseRuffSettings(result.stdout);
}

/**
 * ruff's effective settings for the project's config against the base's, both as ruff itself
 * resolves them. The base is rendered afresh, so a stale or edited copy doesn't hide anything.
 */
async function ruffStrength(ctx: Bound, file: string): Promise<Finding[]> {
  const base = join(ctx.scratch, RUFF_BASE);
  await writeFile(base, baseRuffText());
  const project = await ruffConfigFile(ctx);
  const [theirs, ours] = await Promise.all([
    showSettings(ctx, base, file),
    showSettings(ctx, project, file),
  ]);
  return weakerRuff(theirs, ours).map((w) => weaker(ctx, project, RUFF_BASE, w));
}

/** basedpyright prints no effective config, so Talos follows the `extends` chain itself. */
async function pyrightStrength(ctx: Bound): Promise<Finding[]> {
  const project = await pyrightConfigFile(ctx);
  const resolved = await resolvePyright(join(componentDir(ctx), project));
  return weakerPyright(resolved).map((w) => weaker(ctx, project, PYRIGHT_BASE, w));
}

/** Files that loosen themselves with a `# pyright:` comment, which no config file can undo. */
async function commentStrength(ctx: Bound, files: readonly string[]): Promise<Finding[]> {
  const dir = componentDir(ctx);
  const found = await Promise.all(
    files.map(async (file) =>
      weakerComments(await readFile(join(dir, file), 'utf8')).map((comment): Finding => ({
        rule: 'config/weaker',
        message: `This comment sets "${comment.directive}" for the file, which is weaker than ${PYRIGHT_BASE}.`,
        location: { file: inRepo(ctx.component.root, file), line: comment.line },
      })),
    ),
  );
  return found.flat();
}

export async function strength(ctx: Bound): Promise<Finding[]> {
  const files = pythonFiles(ctx);
  const [file] = files;
  if (file === undefined) throw new EngineError('py/config-strength ran with no Python files');
  const found = await Promise.all([
    ruffStrength(ctx, file),
    pyrightStrength(ctx),
    commentStrength(ctx, files),
  ]);
  return found.flat();
}
