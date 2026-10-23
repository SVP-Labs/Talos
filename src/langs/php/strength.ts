import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toNeon } from './neon.js';
import { absolute, fileExists, inRepo, tracks } from './paths.js';
import { PHPMD_BASE, PHPMD_PROJECT } from './phpmd-config.js';
import {
  gateIncludes,
  PHPSTAN_BASE,
  PHPSTAN_PARAMETERS,
  PHPSTAN_PROJECT,
} from './phpstan-config.js';
import { installerPackages, laravelApp } from './phpstan.js';
import { type Bound, runVendorTool } from './run.js';
import {
  asMap,
  type Located,
  phpmdExcludes,
  phpunitExcludes,
  type Weakening,
  weakerPhpstan,
} from './strength-rules.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

/**
 * `phpstan dump-parameters` prints the environment among the parameters, so its output is only
 * parsed, never put in an error.
 */
async function dumpParameters(ctx: Bound, config: string): Promise<Record<string, unknown>> {
  const result = await runVendorTool(ctx, 'phpstan', ['dump-parameters', '-c', config, '--json']);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    value = undefined;
  }
  const params = asMap(value);
  if (result.code !== 0 || params === undefined) {
    const reason = result.stderr.trim().split('\n').slice(-5).join('\n');
    throw new EngineError(`phpstan dump-parameters exited ${result.code}:\n${reason}`);
  }
  return params;
}

async function parameters(ctx: Bound, project: boolean): Promise<Record<string, unknown>> {
  const includes = await gateIncludes(ctx, {
    laravel: laravelApp(ctx),
    installed: await installerPackages(ctx),
    project,
  });
  const name = project ? 'effective' : 'base';
  const config = join(ctx.scratch, `${name}.neon`);
  const tmpDir = join(ctx.scratch, `${name}-tmp`);
  await writeFile(config, toNeon({ includes, parameters: { ...PHPSTAN_PARAMETERS, tmpDir } }));
  return dumpParameters(ctx, config);
}

/** PHPStan's parameters with the project's extension against the base's alone. */
async function phpstanStrength(ctx: Bound): Promise<Finding[]> {
  if (!(await fileExists(absolute(ctx, PHPSTAN_PROJECT)))) return [];
  const [base, effective] = await Promise.all([parameters(ctx, false), parameters(ctx, true)]);
  const where = inRepo(ctx.component.root, PHPSTAN_PROJECT);
  return weakerPhpstan(base, effective).map((w: Weakening) => ({
    rule: 'config/weaker',
    key: `${where} ${w.setting}`,
    message: `${where} ${w.message}, which is weaker than ${PHPSTAN_BASE}.`,
  }));
}

function located(ctx: Bound, file: string, found: readonly Located[]): Finding[] {
  return found.map((l) => ({
    rule: 'config/weaker',
    message: l.message,
    location: { file: inRepo(ctx.component.root, file), line: l.line },
  }));
}

async function textOf(ctx: Bound, file: string): Promise<string | undefined> {
  return tracks(ctx, file) ? readFile(absolute(ctx, file), 'utf8') : undefined;
}

/** PHPUnit reads the first of these it finds. */
const PHPUNIT_CONFIGS = ['phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml'];

/** PHPMD reads the first of these it finds, and every one of them comes before phpmd.xml. */
const PHPMD_FIRST = ['yml', 'yaml', 'json'].flatMap((ext) => [
  `phpmd.${ext}`,
  `.phpmd.${ext}`,
  `phpmd.${ext}.dist`,
]);

/**
 * php/config-strength: what the project's files change about the base. PHPMD's and PHPStan's
 * gate runs always apply the base in full, so this is about what editors show, and about the
 * settings the gate does take from the project (PHPStan's allow-lists, PHPUnit's coverage source).
 */
export async function strength(ctx: Bound): Promise<Finding[]> {
  const findings = await phpstanStrength(ctx);
  const phpmd = await textOf(ctx, PHPMD_PROJECT);
  if (phpmd !== undefined) {
    findings.push(...located(ctx, PHPMD_PROJECT, phpmdExcludes(phpmd)));
  }
  const phpunit = PHPUNIT_CONFIGS.find((name) => tracks(ctx, name));
  const text = phpunit === undefined ? undefined : await textOf(ctx, phpunit);
  if (phpunit !== undefined && text !== undefined) {
    findings.push(...located(ctx, phpunit, phpunitExcludes(text)));
  }
  for (const name of PHPMD_FIRST.filter((file) => tracks(ctx, file))) {
    findings.push({
      rule: 'config/shadowed',
      message: `PHPMD reads ${inRepo(ctx.component.root, name)} before ${PHPMD_BASE}, so editors miss the base.`,
      key: inRepo(ctx.component.root, name),
    });
  }
  return findings;
}
