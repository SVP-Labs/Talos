import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_COGNITIVE, parseComplexipySarif } from './complexipy.js';
import { ruffConfigFile } from './configs.js';
import { componentDir, fileExists, fromTool, inRepo, isTestPath, pythonFiles } from './paths.js';
import { parseRuffJson, sentence } from './ruff.js';
import { failed, runTool, type ToolContext } from './run.js';
import { sizeFindings } from './sizes.js';
import { readSpans } from './spans.js';
import type { CheckContext } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

type Lint = ToolContext & Pick<CheckContext, 'facts'>;

async function ruffFindings(ctx: Lint, files: readonly string[]): Promise<Finding[]> {
  const config = await ruffConfigFile(ctx);
  const args = ['check', '--no-cache', '--no-fix', '--output-format', 'json', '--config', config];
  const result = await runTool(ctx, 'ruff', [...args, ...files]);
  if (result.code > 1 && !result.stdout.trimStart().startsWith('[')) {
    throw failed('ruff check', result);
  }
  return parseRuffJson(result.stdout).map((d) => ({
    rule: `ruff/${d.code}`,
    message: sentence(d.message),
    location: { file: fromTool(ctx, d.file), line: d.line, endLine: d.endLine, column: d.column },
    ...(d.url === undefined ? {} : { docs: d.url }),
  }));
}

/**
 * complexipy reads its own settings from the directory it runs in, so it runs in the scratch
 * directory on absolute paths: a project's file can't raise the limit or turn on a baseline.
 */
async function cognitiveFindings(ctx: Lint, files: readonly string[]): Promise<Finding[]> {
  const out = join(ctx.scratch, 'complexipy.sarif');
  const dir = componentDir(ctx);
  const args = [
    ...files.map((file) => join(dir, file)),
    '--output-format',
    'sarif',
    '--output',
    out,
    '--color',
    'no',
    '--max-complexity-allowed',
    String(MAX_COGNITIVE),
    '--failed=true',
    '--quiet=true',
    '--snapshot-ignore=true',
    '--cache-dir',
    join(ctx.scratch, 'complexipy-cache'),
  ];
  const result = await runTool(ctx, 'complexipy', args, { cwd: ctx.scratch });
  if (result.code > 1 || !(await fileExists(out))) throw failed('complexipy', result);
  return parseComplexipySarif(await readFile(out, 'utf8')).map((f) => ({
    rule: `complexipy/${f.rule}`,
    message:
      `Function '${f.name}' has a cognitive complexity of ${f.complexity}; ` +
      `the most allowed is ${MAX_COGNITIVE}.`,
    location: { file: fromTool(ctx, f.file), line: f.line, endLine: f.endLine },
  }));
}

async function sizes(ctx: Lint, files: readonly string[]): Promise<Finding[]> {
  const shipped = files.filter((file) => file.endsWith('.py') && !isTestPath(file));
  const spans = await readSpans(ctx, shipped);
  const dir = componentDir(ctx);
  const findings = await Promise.all(
    [...spans].map(async ([file, found]) =>
      sizeFindings(
        inRepo(ctx.component.root, file),
        await readFile(join(dir, file), 'utf8'),
        found,
      ),
    ),
  );
  return findings.flat();
}

/** ruff with every rule, complexipy for cognitive complexity, and the file and function sizes. */
export async function lint(ctx: Lint): Promise<Finding[]> {
  const files = pythonFiles(ctx);
  if (files.length === 0) throw new EngineError('py/lint ran on a component with no Python files');
  const sources = files.filter((file) => file.endsWith('.py'));
  const found = await Promise.all([
    ruffFindings(ctx, files),
    sources.length > 0 ? cognitiveFindings(ctx, sources) : Promise.resolve([]),
    sizes(ctx, files),
  ]);
  return found.flat();
}
