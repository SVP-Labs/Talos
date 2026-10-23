import { readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { cruiseOnce } from './arch.js';
import { lintRun, lintTargets } from './lint.js';
import { type Check, type CheckContext, skip, APPLIES } from '../../../core/check.js';
import type { Finding } from '../../../core/finding.js';
import { weakerFlags, weakerRules, type Weakening } from '../compare.js';
import { UNIVERSAL_RULES, DEPCRUISE_PROJECT } from '../configs/depcruise.js';
import { ESLINT_BASE, ESLINT_PROJECT } from '../configs/eslint.js';
import { KNIP_PROJECT, KNIP_WEAKENING_KEYS } from '../configs/knip.js';
import {
  componentFiles,
  inComponent,
  inRepo,
  isJavaScript,
  isTest,
  isTooling,
  rootOf,
  tsconfigs,
} from '../files.js';
import { componentDir, nodeTool, parseJson, runTool } from '../node.js';
import { shadowingFindings } from '../shadows.js';

const printed = z.looseObject({
  rules: z.record(z.string(), z.unknown()).default({}),
  linterOptions: z
    .looseObject({ reportUnusedDisableDirectives: z.unknown().optional() })
    .default({}),
});

/**
 * One file of each kind ESLint treats differently: source, TSX, tests, JavaScript (a source
 * when there is one, and a tool config).
 */
export function representatives(files: readonly string[]): string[] {
  const kinds: ((file: string) => boolean)[] = [
    (file) => /\.[cm]?ts$/.test(file) && !isTest(file),
    (file) => file.endsWith('.tsx') && !isTest(file),
    (file) => isTest(file) && !isJavaScript(file),
    (file) => isJavaScript(file) && !isTooling(file),
    (file) => isJavaScript(file) && isTooling(file),
  ];
  return kinds.flatMap((matches) => {
    const first = files.find((file) => matches(file));
    return first === undefined ? [] : [first];
  });
}

/** The span of a whole file, so any change to it touches the findings it causes. */
async function wholeFile(ctx: CheckContext, file: string): Promise<Finding['location']> {
  const text = await readFile(join(ctx.root, file), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  return { file, line: 1, endLine: Math.max(1, text.replace(/\r?\n$/, '').split(/\r?\n/).length) };
}

async function weaker(
  ctx: CheckContext,
  where: string,
  key: string,
  message: string,
): Promise<Finding> {
  const location = await wholeFile(ctx, where);
  return {
    rule: 'config/weaker',
    message,
    key,
    ...(location === undefined ? {} : { location }),
  };
}

type Printed = z.infer<typeof printed>;

/** The rules, with the unused-directive report as one more severity to keep. */
function settings(config: Printed): Record<string, unknown> {
  const reports = config.linterOptions.reportUnusedDisableDirectives;
  return { ...config.rules, 'linterOptions/reportUnusedDisableDirectives': reports };
}

async function printConfig(
  ctx: CheckContext,
  config: string,
  file: string,
): Promise<Printed | undefined> {
  const tool = await nodeTool(ctx, 'eslint', 'eslint');
  const result = await runTool(ctx, tool, ['--config', config, '--print-config', file]);
  const text = result.stdout.trim();
  if (result.code !== 0 || !text.startsWith('{')) return undefined;
  return printed.parse(parseJson('eslint --print-config', text));
}

async function eslintRules(ctx: CheckContext): Promise<Finding[]> {
  const root = rootOf(ctx.component);
  const run = await lintRun(ctx);
  const ignored = new Set(run.ignored.map((file) => inComponent(root, file)));
  const files = representatives((await lintTargets(ctx)).filter((file) => !ignored.has(file)));
  const wrapper = join(ctx.scratch, 'eslint.base.mjs');
  const base = pathToFileURL(join(componentDir(ctx), ESLINT_BASE)).href;
  await writeFile(wrapper, `export { base as default } from ${JSON.stringify(base)};\n`);
  const found = new Map<string, Weakening & { file: string }>();
  for (const file of files) {
    const [only, effective] = await Promise.all([
      printConfig(ctx, wrapper, file),
      printConfig(ctx, ESLINT_BASE, file),
    ]);
    if (only === undefined || effective === undefined) continue;
    for (const weakening of weakerRules(settings(only), settings(effective))) {
      const key = `${weakening.subject}/${weakening.kind}`;
      if (!found.has(key)) found.set(key, { ...weakening, file });
    }
  }
  const project = inRepo(root, ESLINT_PROJECT);
  return Promise.all(
    [...found.entries()].map(([key, w]) =>
      weaker(
        ctx,
        project,
        `eslint ${key}`,
        `${ESLINT_PROJECT} ${w.how} (seen on ${inRepo(root, w.file)}); it may only tighten the base.`,
      ),
    ),
  );
}

async function eslintIgnores(ctx: CheckContext): Promise<Finding[]> {
  const run = await lintRun(ctx);
  const project = inRepo(rootOf(ctx.component), ESLINT_PROJECT);
  return Promise.all(
    run.ignored.map((file) =>
      weaker(
        ctx,
        project,
        `eslint ignores ${file}`,
        `ESLint skips ${file}, which talos.yml does not exclude: exclude it there, or let ESLint check it.`,
      ),
    ),
  );
}

const shown = z.looseObject({ compilerOptions: z.record(z.string(), z.unknown()).default({}) });

async function tscFlags(ctx: CheckContext): Promise<Finding[]> {
  const tool = await nodeTool(ctx, 'typescript', 'tsc');
  const findings: Finding[] = [];
  for (const tsconfig of tsconfigs(ctx)) {
    const cwd = join(ctx.root, posix.dirname(tsconfig));
    const result = await runTool(ctx, tool, ['--showConfig', '-p', 'tsconfig.json'], { cwd });
    if (result.code !== 0 || !result.stdout.trim().startsWith('{')) continue;
    const options = shown.parse(parseJson('tsc --showConfig', result.stdout)).compilerOptions;
    for (const w of weakerFlags(options)) {
      findings.push(
        await weaker(
          ctx,
          tsconfig,
          `tsc ${tsconfig} ${w.subject}`,
          `${tsconfig} ${w.how}; it may only tighten the base.`,
        ),
      );
    }
  }
  return findings;
}

async function knipKeys(ctx: CheckContext): Promise<Finding[]> {
  const file = inRepo(rootOf(ctx.component), KNIP_PROJECT);
  const text = await readFile(join(ctx.root, file), 'utf8').catch(() => undefined);
  if (text === undefined) return [];
  const parsed = z.record(z.string(), z.unknown()).safeParse(parseJson(KNIP_PROJECT, text));
  if (!parsed.success) return [];
  const keys = KNIP_WEAKENING_KEYS.filter((key) => key in parsed.data);
  return Promise.all(
    keys.map((key) =>
      weaker(
        ctx,
        file,
        `knip ${key}`,
        `${KNIP_PROJECT} sets ${key}, which can only hide unused code.`,
      ),
    ),
  );
}

async function cruiseRules(ctx: CheckContext): Promise<Finding[]> {
  const result = await cruiseOnce(ctx);
  const used = result.summary.ruleSetUsed.forbidden;
  const missing = UNIVERSAL_RULES.filter(
    (name) => !used.some((rule) => rule.name === name && rule.severity === 'error'),
  );
  const narrowed = 'includeOnly' in result.summary.optionsUsed ? ['includeOnly'] : [];
  const file = inRepo(rootOf(ctx.component), DEPCRUISE_PROJECT);
  return Promise.all([
    ...missing.map((name) =>
      weaker(
        ctx,
        file,
        `depcruise ${name}`,
        `dependency-cruiser no longer enforces ${name} as an error.`,
      ),
    ),
    ...narrowed.map((option) =>
      weaker(
        ctx,
        file,
        `depcruise ${option}`,
        `${DEPCRUISE_PROJECT} sets ${option}, which leaves code unchecked.`,
      ),
    ),
  ]);
}

async function run(ctx: CheckContext): Promise<Finding[]> {
  const parts = await Promise.all([
    eslintRules(ctx),
    eslintIgnores(ctx),
    tscFlags(ctx),
    knipKeys(ctx),
    cruiseRules(ctx),
    shadowingFindings(ctx),
  ]);
  return parts.flat();
}

export const strengthCheck: Check = {
  id: 'ts/config-strength',
  tier: 'head',
  scope: 'component',
  langs: ['ts'],
  title: 'Tool configs no weaker than the base',
  applies: (ctx) => (componentFiles(ctx).length > 0 ? APPLIES : skip('the component has no files')),
  run,
};
