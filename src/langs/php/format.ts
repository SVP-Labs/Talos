import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { absolute, fromTool, phpFiles } from './paths.js';
import { renderPint } from './pint-config.js';
import { type Bound, failed, jsonFrom, runVendorTool } from './run.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

/** pint fixing files with `-v --format=json` prints PHP CS Fixer's report. */
const report = z.object({
  files: z
    .array(z.object({ name: z.string(), appliedFixers: z.array(z.string()).default([]) }))
    .default([]),
});

export type Fixed = { readonly path: string; readonly fixers: readonly string[] };

export function parsePintJson(json: unknown): Fixed[] {
  const parsed = report.safeParse(json);
  if (!parsed.success) throw new EngineError('pint printed JSON Talos cannot read');
  return parsed.data.files.map((file) => ({ path: file.name, fixers: file.appliedFixers }));
}

/** The first to the last line pint changed, from the file before and after; 1-based. */
export function changedSpan(
  before: string,
  after: string,
): { line: number; endLine: number } | undefined {
  const old = before.split('\n');
  const now = after.split('\n');
  let head = 0;
  while (head < old.length && head < now.length && old[head] === now[head]) head += 1;
  if (head === old.length && head === now.length) return undefined;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < now.length - head &&
    old[old.length - 1 - tail] === now[now.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { line: head + 1, endLine: Math.max(head + 1, old.length - tail) };
}

function lines(span: { line: number; endLine: number }): string {
  return span.line === span.endLine
    ? `Line ${span.line} is`
    : `Lines ${span.line} to ${span.endLine} are`;
}

export function formatFinding(
  file: string,
  span: { line: number; endLine: number },
  fixers: readonly string[],
): Finding {
  const more = fixers.length > 5 ? ', …' : '';
  const which = fixers.length === 0 ? '' : ` (${fixers.slice(0, 5).join(', ')}${more})`;
  return {
    rule: 'pint/format',
    message: `${lines(span)} not formatted the way pint writes them${which}.`,
    location: { file, ...span },
  };
}

const CHUNK = 200;

/**
 * pint fixes copies of the component's PHP files in the scratch directory with the base config
 * as Talos renders it; each file it changed is one finding, from its first to its last changed
 * line. A file pint can't parse is left to php/types, which reports the syntax error.
 */
export async function format(ctx: Bound): Promise<Finding[]> {
  const files = phpFiles(ctx);
  const copy = join(ctx.scratch, 'copy');
  for (const file of files) {
    const target = join(copy, ...file.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(absolute(ctx, file), target);
  }
  const config = join(ctx.scratch, 'pint.json');
  await writeFile(config, renderPint(''));
  const fixed: Fixed[] = [];
  for (let start = 0; start < files.length; start += CHUNK) {
    const chunk = files.slice(start, start + CHUNK);
    const args = [
      '-v',
      '--format=json',
      `--config=${config}`,
      `--cache-file=${join(ctx.scratch, 'pint.cache')}`,
    ];
    const result = await runVendorTool(ctx, 'pint', [...args, ...chunk], { cwd: copy });
    if (!result.stdout.includes('{"')) throw failed('pint', result);
    fixed.push(...parsePintJson(jsonFrom(result.stdout, 'pint')));
  }
  const findings: Finding[] = [];
  for (const { path, fixers } of fixed) {
    const file = path.replaceAll('\\', '/');
    const [before, after] = await Promise.all([
      readFile(absolute(ctx, file), 'utf8'),
      readFile(join(copy, ...file.split('/')), 'utf8'),
    ]);
    const span = changedSpan(before, after);
    if (span !== undefined) findings.push(formatFinding(fromTool(ctx, file), span, fixers));
  }
  return findings;
}
