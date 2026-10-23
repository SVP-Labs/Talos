import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { absolute, fileExists, fromTool, isTestPath, phpFiles } from './paths.js';
import { PHPMD_PROJECT, renderPhpmd } from './phpmd-config.js';
import { type Bound, failed, jsonFrom, runVendorTool, sentence } from './run.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

const violation = z.object({
  beginLine: z.number().int(),
  endLine: z.number().int(),
  description: z.string(),
  rule: z.string(),
});

const report = z.object({
  files: z.array(z.object({ file: z.string(), violations: z.array(violation) })).default([]),
  errors: z.array(z.object({ fileName: z.string(), message: z.string() })).default([]),
});

/** The size limits test code is exempt from, as in every other language. */
const SIZE_RULES = new Set([
  'ExcessiveMethodLength',
  'ExcessiveClassLength',
  'NcssMethodCount',
  'NcssTypeCount',
  'NcssConstructorCount',
]);

/**
 * PHPMD's JSON report as findings. A file PHPMD can't parse is a finding of its own, so a file
 * in syntax its parser doesn't know yet is never left out of linting in silence. `toRepo` makes
 * PHPMD's absolute paths repository-relative; test files keep no size findings.
 */
export function parsePhpmdJson(json: unknown, toRepo: (file: string) => string): Finding[] {
  const parsed = report.safeParse(json);
  if (!parsed.success) throw new EngineError('PHPMD printed JSON Talos cannot read');
  const violations = parsed.data.files.flatMap(({ file, violations: found }) => {
    const path = toRepo(file);
    return found
      .filter((v) => !(SIZE_RULES.has(v.rule) && isTestPath(path)))
      .map((v): Finding => ({
        rule: `phpmd/${v.rule}`,
        message: sentence(v.description),
        location: { file: path, line: v.beginLine, endLine: Math.max(v.beginLine, v.endLine) },
      }));
  });
  const errors = parsed.data.errors.map((e): Finding => ({
    rule: 'phpmd/parse-error',
    message: sentence(`PHPMD could not read this file: ${e.message.replace(/ in file: .*$/, '')}`),
    location: { file: toRepo(e.fileName), line: 1 },
  }));
  return dedupe([...violations, ...errors]);
}

/** The base and an extension can hold the same rule; one violation is one finding. */
function dedupe(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const id = JSON.stringify([f.rule, f.message, f.location]);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * PHPMD over every checked file with the base ruleset as Talos renders it, which references the
 * project's extension by absolute path when there is one.
 */
export async function phpmd(ctx: Bound): Promise<Finding[]> {
  const files = phpFiles(ctx);
  const project = absolute(ctx, PHPMD_PROJECT);
  const ruleset = join(ctx.scratch, 'phpmd.xml');
  await writeFile(ruleset, renderPhpmd('', (await fileExists(project)) ? project : undefined));
  const list = join(ctx.scratch, 'phpmd-files.txt');
  await writeFile(list, `${files.map((file) => absolute(ctx, file)).join('\n')}\n`);
  const args = ['analyze', '--format=json', `--ruleset=${ruleset}`, `--input-file=${list}`];
  const result = await runVendorTool(ctx, 'phpmd', [...args, '--no-progress', '--no-ansi']);
  if (!result.stdout.trimStart().startsWith('{')) throw failed('phpmd analyze', result);
  return parsePhpmdJson(jsonFrom(result.stdout, 'phpmd'), (file) => fromTool(ctx, file));
}
