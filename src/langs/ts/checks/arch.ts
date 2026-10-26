import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { type Check, type CheckContext, EngineError, skip, APPLIES } from '../../../core/check.js';
import type { Finding } from '../../../core/finding.js';
import { DEPCRUISE_BASE } from '../configs/depcruise.js';
import { componentFiles, inComponent, inRepo, isCode, rootOf } from '../files.js';
import { componentDir, nodeTool, parseJson, runTool, tail } from '../node.js';

const violation = z.looseObject({
  type: z.string().optional(),
  from: z.string(),
  to: z.string(),
  unresolvedTo: z.string().optional(),
  rule: z.object({ name: z.string(), severity: z.string() }),
  cycle: z.array(z.looseObject({ name: z.string() })).optional(),
});

const dependency = z.looseObject({ module: z.string(), resolved: z.string() });

const cruise = z.object({
  modules: z.array(
    z.looseObject({ source: z.string(), dependencies: z.array(dependency).default([]) }),
  ),
  summary: z.looseObject({
    violations: z.array(violation),
    ruleSetUsed: z.looseObject({
      forbidden: z.array(z.looseObject({ name: z.string(), severity: z.string() })).default([]),
    }),
    optionsUsed: z.looseObject({}),
  }),
});

export type Cruise = z.infer<typeof cruise>;
type Violation = z.infer<typeof violation>;

export function parseCruise(json: unknown): Cruise {
  const parsed = cruise.safeParse(json);
  if (!parsed.success) throw new EngineError('dependency-cruiser wrote JSON Talos cannot read');
  return parsed.data;
}

/** The specifier `from` imports `to` by, as written in its source. */
export function specifierOf(result: Cruise, from: string, to: string): string | undefined {
  const module = result.modules.find((m) => m.source === from);
  return module?.dependencies.find((d) => d.resolved === to)?.module;
}

/** The first line that names the specifier in quotes, or 1. */
export function importLine(lines: readonly string[], specifier: string | undefined): number {
  if (specifier === undefined) return 1;
  const quoted = [`'${specifier}'`, `"${specifier}"`, `\`${specifier}\``];
  const index = lines.findIndex((line) => quoted.some((q) => line.includes(q)));
  return index + 1 || 1;
}

function describe(found: Violation): string {
  const target = found.unresolvedTo ?? found.to;
  if (found.cycle !== undefined && found.cycle.length > 0) {
    const path = [found.from, ...found.cycle.map((step) => step.name)];
    return `This import closes a cycle: ${path.join(' -> ')}.`;
  }
  const what: Readonly<Record<string, string>> = {
    'no-test-code-in-shipped-code': `Shipped code imports test code (${target}).`,
    'no-dev-deps-in-shipped-code': `Shipped code imports ${target}, a devDependency.`,
    'no-unresolvable': `${target} cannot be resolved.`,
  };
  return what[found.rule.name] ?? `Importing ${target} breaks the rule ${found.rule.name}.`;
}

/** Violations as findings at the import line; paths are component-relative until `root` joins. */
export function cruiseFindings(
  result: Cruise,
  root: string,
  sourceLines: (file: string) => readonly string[],
): Finding[] {
  return result.summary.violations
    .filter((found) => found.rule.severity === 'error' || found.rule.severity === 'warn')
    .map((found) => {
      const specifier = found.unresolvedTo ?? specifierOf(result, found.from, found.to);
      return {
        rule: `depcruise/${found.rule.name}`,
        message: describe(found),
        location: {
          file: inRepo(root, found.from),
          line: importLine(sourceLines(found.from), specifier),
        },
      };
    });
}

/** The roots to cruise: each top-level entry under the component that holds code. */
export function cruiseRoots(files: readonly string[]): string[] {
  return [
    ...new Set(files.filter((file) => isCode(file)).map((file) => file.split('/')[0] ?? file)),
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

async function cruiseRun(ctx: CheckContext): Promise<Cruise> {
  const root = rootOf(ctx.component);
  const tool = await nodeTool(ctx, 'dependency-cruiser', 'depcruise');
  const roots = cruiseRoots(componentFiles(ctx).map((file) => inComponent(root, file)));
  const output = join(ctx.scratch, 'depcruise.json');
  const args = [
    ...roots,
    '--config',
    DEPCRUISE_BASE,
    '--output-type',
    'json',
    '--output-to',
    output,
  ];
  const result = await runTool(ctx, tool, args);
  const text = await readFile(output, 'utf8').catch(() => undefined);
  if (text === undefined) {
    throw new EngineError(`dependency-cruiser exited ${result.code}:\n${tail(result)}`);
  }
  return parseCruise(parseJson('dependency-cruiser', text));
}

/** The component's dependency-cruiser run, shared with the config-strength check. */
export function cruiseOnce(ctx: CheckContext): Promise<Cruise> {
  return ctx.memo(`ts/depcruise@${rootOf(ctx.component)}`, () => cruiseRun(ctx));
}

async function run(ctx: CheckContext): Promise<Finding[]> {
  const result = await cruiseOnce(ctx);
  const dir = componentDir(ctx);
  const texts = new Map<string, readonly string[]>();
  for (const file of new Set(result.summary.violations.map((v) => v.from))) {
    const text = await readFile(join(dir, file), 'utf8').catch(() => '');
    texts.set(file, text.split(/\r?\n/));
  }
  return cruiseFindings(result, rootOf(ctx.component), (file) => texts.get(file) ?? []);
}

export const archCheck: Check = {
  id: 'ts/arch',
  tier: 'head',
  scope: 'component',
  langs: ['ts'],
  title: 'dependency-cruiser: architecture',
  applies: (ctx) =>
    componentFiles(ctx).some((file) => isCode(file))
      ? APPLIES
      : skip('no TypeScript or JavaScript'),
  run,
};
