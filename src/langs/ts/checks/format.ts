import { readFile } from 'node:fs/promises';
import { extname, join, posix } from 'node:path';
import { type Check, type CheckContext, EngineError, skip, APPLIES } from '../../../core/check.js';
import type { Finding } from '../../../core/finding.js';
import { GENERATED_PATHS } from '../configs/index.js';
import { PRETTIER_CONFIG } from '../configs/prettier.js';
import { componentFiles, inComponent, inRepo, LOCKFILES, rootOf } from '../files.js';
import { withoutGenerated } from '../generated.js';
import { batches, componentDir, nodeTool, runTool, tail } from '../node.js';

const FORMATTED = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.json5',
  '.md',
  '.mdx',
  '.yaml',
  '.yml',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.vue',
  '.graphql',
  '.gql',
]);

/** Files Prettier formats, minus lockfiles and the files Talos renders (component-relative). */
export function formatTargets(files: readonly string[], root: string): string[] {
  return files
    .map((file) => inComponent(root, file))
    .filter((file) => FORMATTED.has(extname(file)))
    .filter((file) => !GENERATED_PATHS.includes(file))
    .filter((file) => !(LOCKFILES as readonly string[]).includes(posix.basename(file)));
}

export type PrettierError = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

export type PrettierResult = {
  readonly unformatted: readonly string[];
  readonly errors: readonly PrettierError[];
};

const ERROR = /^\[error\] (.+?): (\w*Error): (.+?) \((\d+):(\d+)\)$/;

/** Reads `prettier --list-different`: unformatted files on stdout, parse errors on stderr. */
export function parsePrettier(stdout: string, stderr: string): PrettierResult {
  const unformatted = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('['));
  const errors = stderr.split(/\r?\n/).flatMap((line): PrettierError[] => {
    const match = ERROR.exec(line);
    if (match === null) return [];
    const [, file = '', , message = '', at = '1', column = '1'] = match;
    return [{ file, line: Number(at), column: Number(column), message }];
  });
  return { unformatted, errors };
}

async function lineCount(path: string): Promise<number> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return Math.max(1, text.replace(/\r?\n$/, '').split(/\r?\n/).length);
}

async function prettier(ctx: CheckContext, targets: readonly string[]): Promise<PrettierResult> {
  const tool = await nodeTool(ctx, 'prettier', 'prettier');
  const unformatted: string[] = [];
  const errors: PrettierError[] = [];
  for (const batch of batches(targets)) {
    const args = ['--config', PRETTIER_CONFIG, '--list-different', '--ignore-unknown', ...batch];
    const result = await runTool(ctx, tool, args);
    const parsed = parsePrettier(result.stdout, result.stderr);
    if (result.code === 2 && parsed.errors.length === 0) {
      throw new EngineError(`prettier failed:\n${tail(result)}`);
    }
    unformatted.push(...parsed.unformatted);
    errors.push(...parsed.errors);
  }
  return { unformatted, errors };
}

async function run(ctx: CheckContext): Promise<Finding[]> {
  const root = rootOf(ctx.component);
  const dir = componentDir(ctx);
  const targets = await withoutGenerated(dir, formatTargets(componentFiles(ctx), root));
  if (targets.length === 0) return [];
  const result = await prettier(ctx, targets);
  const unformatted = await Promise.all(
    result.unformatted.map(async (file): Promise<Finding> => ({
      rule: 'prettier/unformatted',
      message: `${inRepo(root, file)} is not formatted as Prettier formats it.`,
      location: { file: inRepo(root, file), line: 1, endLine: await lineCount(join(dir, file)) },
    })),
  );
  const broken = result.errors.map((error): Finding => ({
    rule: 'prettier/syntax-error',
    message: `Prettier cannot parse this file: ${error.message.replace(/\.$/, '')}.`,
    location: { file: inRepo(root, error.file), line: error.line, column: error.column },
  }));
  return [...unformatted, ...broken];
}

export const formatCheck: Check = {
  id: 'ts/format',
  tier: 'commit',
  scope: 'component',
  langs: ['ts'],
  title: 'Prettier formatting',
  applies: (ctx) =>
    formatTargets(componentFiles(ctx), rootOf(ctx.component)).length > 0
      ? APPLIES
      : skip('no files Prettier formats'),
  run,
};
