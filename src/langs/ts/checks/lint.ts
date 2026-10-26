import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { type Check, type CheckContext, EngineError, skip, APPLIES } from '../../../core/check.js';
import type { Finding } from '../../../core/finding.js';
import { ESLINT_BASE } from '../configs/eslint.js';
import { componentFiles, inComponent, isCode, rootOf } from '../files.js';
import { withoutGenerated } from '../generated.js';
import { batches, componentDir, nodeTool, parseJson, runTool, tail } from '../node.js';
import { functionEnds } from '../spans.js';

const message = z.object({
  ruleId: z.string().nullable().optional(),
  severity: z.number(),
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  endLine: z.number().optional(),
  fatal: z.boolean().optional(),
});

const report = z.array(z.object({ filePath: z.string(), messages: z.array(message) }));

type LintProblem = {
  readonly rule: string;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly endLine?: number;
};

export type LintRun = {
  readonly problems: readonly LintProblem[];
  /** Files ESLint was given and skipped because its config ignores them (repository-relative). */
  readonly ignored: readonly string[];
};

const IGNORED = /^File ignored\b/;
const UNUSED_DIRECTIVE = /^Unused eslint-(?:disable|enable) directive/;

function ruleOf(entry: z.infer<typeof message>): string {
  if (entry.fatal === true) return 'eslint/parse-error';
  if (entry.ruleId !== null && entry.ruleId !== undefined) return `eslint/${entry.ruleId}`;
  return UNUSED_DIRECTIVE.test(entry.message) ? 'eslint/unused-directive' : 'eslint/config-error';
}

/** One clear sentence: whitespace collapsed, at most 300 characters. */
export function sentence(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

/**
 * Reads ESLint's JSON formatter output. `toRepo` turns its absolute paths into repository-relative
 * ones; the "file ignored" warnings ESLint gives for skipped files are listed apart.
 */
export function parseEslint(json: unknown, toRepo: (absolute: string) => string): LintRun {
  const parsed = report.safeParse(json);
  if (!parsed.success) throw new EngineError('eslint wrote JSON Talos cannot read');
  const problems: LintProblem[] = [];
  const ignored: string[] = [];
  for (const result of parsed.data) {
    const file = toRepo(result.filePath);
    for (const entry of result.messages) {
      if (entry.ruleId == null && entry.fatal !== true && IGNORED.test(entry.message)) {
        ignored.push(file);
        continue;
      }
      problems.push({
        rule: ruleOf(entry),
        message: sentence(entry.message),
        file,
        line: entry.line ?? 1,
        ...(entry.column === undefined ? {} : { column: entry.column }),
        ...(entry.endLine === undefined ? {} : { endLine: entry.endLine }),
      });
    }
  }
  return { problems, ignored };
}

/** Rules about a whole function whose report points at its head only. */
const FUNCTION_RULES = new Set([
  'eslint/complexity',
  'eslint/sonarjs/cognitive-complexity',
  'eslint/max-statements',
]);

/** Widens function-level findings to the whole function, so a change inside it touches them. */
async function widen(ctx: CheckContext, problems: readonly LintProblem[]): Promise<LintProblem[]> {
  const wanted = problems.filter((p) => FUNCTION_RULES.has(p.rule));
  const ends = await functionEnds(
    ctx,
    wanted.map((p) => ({ file: join(ctx.root, p.file), line: p.line, column: p.column ?? 1 })),
  );
  const endOf = new Map(wanted.map((p, index) => [p, ends[index] ?? null]));
  return problems.map((p) => {
    const end = endOf.get(p);
    return end === undefined || end === null || end <= p.line ? p : { ...p, endLine: end };
  });
}

/** Files ESLint lints: code under the component, minus the files Talos renders. */
export async function lintTargets(ctx: CheckContext): Promise<string[]> {
  const root = rootOf(ctx.component);
  const files = componentFiles(ctx)
    .filter((file) => isCode(file))
    .map((file) => inComponent(root, file));
  return withoutGenerated(componentDir(ctx), files);
}

async function eslint(ctx: CheckContext): Promise<LintRun> {
  const targets = await lintTargets(ctx);
  if (targets.length === 0) return { problems: [], ignored: [] };
  const tool = await nodeTool(ctx, 'eslint', 'eslint');
  const toRepo = (absolute: string): string => relative(ctx.root, absolute).split(sep).join('/');
  const problems: LintProblem[] = [];
  const ignored: string[] = [];
  for (const [index, batch] of batches(targets).entries()) {
    const output = join(ctx.scratch, `eslint-${index}.json`);
    const args = ['--config', ESLINT_BASE, '--format', 'json', '--output-file', output, ...batch];
    const result = await runTool(ctx, tool, args);
    const text = await readFile(output, 'utf8').catch(() => undefined);
    if (result.code > 1 || text === undefined) {
      throw new EngineError(`eslint exited ${result.code}:\n${tail(result)}`);
    }
    const parsed = parseEslint(parseJson('eslint', text), toRepo);
    problems.push(...parsed.problems);
    ignored.push(...parsed.ignored);
  }
  return { problems: await widen(ctx, problems), ignored };
}

/** The component's ESLint run, shared by the lint and config-strength checks of one run. */
export function lintRun(ctx: CheckContext): Promise<LintRun> {
  return ctx.memo(`ts/eslint@${rootOf(ctx.component)}`, () => eslint(ctx));
}

export const lintCheck: Check = {
  id: 'ts/lint',
  tier: 'commit',
  scope: 'component',
  langs: ['ts'],
  title: 'ESLint',
  applies: (ctx) =>
    componentFiles(ctx).some((file) => isCode(file))
      ? APPLIES
      : skip('no TypeScript or JavaScript'),
  run: async (ctx) =>
    (await lintRun(ctx)).problems.map((p): Finding => ({
      rule: p.rule,
      message: p.message,
      location: {
        file: p.file,
        line: p.line,
        ...(p.endLine === undefined ? {} : { endLine: p.endLine }),
        ...(p.column === undefined ? {} : { column: p.column }),
      },
    })),
};
