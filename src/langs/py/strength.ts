import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  baseRuffText,
  PYRIGHT_BASE,
  pyrightConfigFile,
  RUFF_BASE,
  ruffConfigFile,
} from './configs.js';
import { mutmutSettings, outsideSourcePaths, weakerMutmut } from './mutmut-settings.js';
import { isTestPath, pythonFiles } from './paths.js';
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
import { excludeMatcher } from '../../repo/facts.js';

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

async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined);
}

/**
 * The mutmut settings the runner defers to, wherever mutmut reads them: each that never runs a
 * mutant or counts one killed, and source paths that leave a file under talos.yml's mutation
 * paths out.
 */
async function mutmutStrength(ctx: Bound, files: readonly string[]): Promise<Finding[]> {
  const dir = componentDir(ctx);
  const settings = mutmutSettings(
    await readOptional(join(dir, 'pyproject.toml')),
    await readOptional(join(dir, 'setup.cfg')),
  );
  if (settings === undefined) return [];
  const where = inRepo(ctx.component.root, settings.file);
  const mutated = excludeMatcher(ctx.config.mutation);
  const targets = files.filter(
    (file) =>
      file.endsWith('.py') && !isTestPath(file) && mutated(inRepo(ctx.component.root, file)),
  );
  const weakened = weakerMutmut(settings.values).map((w): Finding => ({
    rule: 'config/weaker',
    message: `${where}'s ${settings.table} sets ${w.setting}, which ${w.how}; it may only tighten mutation.`,
    key: `${where} mutmut ${w.setting}`,
  }));
  const outside = outsideSourcePaths(settings.values, targets, files).map((file): Finding => {
    const path = inRepo(ctx.component.root, file);
    return {
      rule: 'config/weaker',
      message: `${where}'s ${settings.table} leaves ${path}, under talos.yml's mutation paths, outside its source paths, so mutmut never mutates it.`,
      key: `${where} mutmut source ${path}`,
    };
  });
  return [...weakened, ...outside];
}

export async function strength(ctx: Bound): Promise<Finding[]> {
  const files = pythonFiles(ctx);
  const [file] = files;
  if (file === undefined) throw new EngineError('py/config-strength ran with no Python files');
  const found = await Promise.all([
    ruffStrength(ctx, file),
    pyrightStrength(ctx),
    commentStrength(ctx, files),
    mutmutStrength(ctx, files),
  ]);
  return found.flat();
}
