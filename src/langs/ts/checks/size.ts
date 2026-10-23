import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { z } from 'zod';
import {
  type ApplyContext,
  type Check,
  type CheckContext,
  EngineError,
  skip,
  APPLIES,
} from '../../../core/check.js';
import type { Finding } from '../../../core/finding.js';
import { inComponent, rootOf } from '../files.js';
import { nodeTool, parseJson, runTool, tail } from '../node.js';

const result = z.union([
  z.object({ error: z.string() }),
  z.array(
    z.looseObject({
      name: z.string(),
      passed: z.boolean().optional(),
      size: z.number().optional(),
      sizeLimit: z.number().optional(),
    }),
  ),
]);

export type SizeEntry = { readonly name: string; readonly size: number; readonly limit: number };

/** Reads `size-limit --json`: the entries over their limit, or the tool's own error. */
export function parseSizeLimit(json: unknown): SizeEntry[] {
  const parsed = result.safeParse(json);
  if (!parsed.success) throw new EngineError('size-limit wrote JSON Talos cannot read');
  if (!Array.isArray(parsed.data)) {
    const first = parsed.data.error.split('\n')[0] ?? '';
    throw new EngineError(`size-limit failed: ${first}`);
  }
  return parsed.data
    .filter((entry) => entry.passed === false)
    .map((entry) => ({ name: entry.name, size: entry.size ?? 0, limit: entry.sizeLimit ?? 0 }));
}

export function formatBytes(bytes: number): string {
  return bytes >= 1000 ? `${(bytes / 1000).toFixed(1)} kB` : `${bytes} B`;
}

export function sizeFindings(
  entries: readonly SizeEntry[],
  configFile: string,
  configLines: readonly string[],
): Finding[] {
  return entries.map((entry) => {
    const index = configLines.findIndex((line) => line.includes(JSON.stringify(entry.name)));
    return {
      rule: 'size-limit/exceeded',
      message: `${entry.name} is ${formatBytes(entry.size)}, over its ${formatBytes(entry.limit)} budget.`,
      key: `size-limit ${entry.name}`,
      location: { file: configFile, line: index + 1 || 1 },
    };
  });
}

/** The TypeScript component the size budget belongs to: the deepest one holding its file. */
export function sizeOwner(ctx: ApplyContext): boolean {
  const size = ctx.config.size;
  if (size === undefined || ctx.component === undefined) return false;
  const holds = (root: string): boolean => root === '.' || size.startsWith(`${root}/`);
  const owners = ctx.config.components
    .filter((c) => c.lang === 'ts')
    .map((c) => rootOf(c))
    .filter((root) => holds(root))
    .sort((a, b) => b.length - a.length);
  return owners[0] === rootOf(ctx.component);
}

async function run(ctx: CheckContext): Promise<Finding[]> {
  const size = ctx.config.size;
  if (size === undefined) return [];
  const tool = await nodeTool(ctx, 'size-limit', 'size-limit');
  const config = inComponent(rootOf(ctx.component), size);
  const output = await runTool(ctx, tool, ['--json', '--config', config]);
  if (!output.stdout.trimStart().startsWith('[') && !output.stdout.trimStart().startsWith('{')) {
    throw new EngineError(`size-limit exited ${output.code}:\n${tail(output)}`);
  }
  const entries = parseSizeLimit(parseJson('size-limit', output.stdout));
  const text = await readFile(join(ctx.root, size), 'utf8').catch(() => '');
  return sizeFindings(entries, posix.normalize(size), text.split(/\r?\n/));
}

export const sizeCheck: Check = {
  id: 'ts/size',
  tier: 'head',
  scope: 'component',
  langs: ['ts'],
  title: 'size-limit budgets',
  applies: (ctx) => (sizeOwner(ctx) ? APPLIES : skip('talos.yml declares no size budget here')),
  run,
};
