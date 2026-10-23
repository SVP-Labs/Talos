import { join, posix, relative, resolve, sep } from 'node:path';
import { sentence } from './lint.js';
import { type Check, type CheckContext, EngineError, skip, APPLIES } from '../../../core/check.js';
import type { Finding } from '../../../core/finding.js';
import { tsconfigs } from '../files.js';
import { nodeTool, runTool, tail } from '../node.js';

export type TscDiagnostic = {
  /** Relative to the directory tsc ran in; absent for a diagnostic about no file. */
  readonly file?: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
};

const LOCATED = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const GLOBAL = /^error (TS\d+): (.*)$/;

/** Reads `tsc --pretty false`; a diagnostic's indented continuation lines are left out. */
export function parseTsc(output: string): TscDiagnostic[] {
  return output.split(/\r?\n/).flatMap((line): TscDiagnostic[] => {
    const located = LOCATED.exec(line);
    if (located !== null) {
      const [, file = '', at = '1', column = '1', code = '', text = ''] = located;
      return [{ file, line: Number(at), column: Number(column), code, message: text }];
    }
    const global = GLOBAL.exec(line);
    if (global === null) return [];
    const [, code = '', text = ''] = global;
    return [{ line: 1, column: 1, code, message: text }];
  });
}

/** A diagnostic as a finding; `toRepo` makes tsc's paths repository-relative. */
export function tscFinding(
  diagnostic: TscDiagnostic,
  toRepo: (file: string) => string,
  tsconfig: string,
): Finding {
  const rule = `tsc/${diagnostic.code}`;
  const message = sentence(diagnostic.message);
  if (diagnostic.file === undefined) return { rule, message, key: `${tsconfig} ${message}` };
  return {
    rule,
    message,
    location: {
      file: toRepo(diagnostic.file),
      line: diagnostic.line,
      column: diagnostic.column,
    },
  };
}

function identity(finding: Finding): string {
  const at = finding.location;
  return `${finding.rule} ${at?.file ?? ''}:${at?.line ?? 0}:${at?.column ?? 0} ${finding.message}`;
}

async function run(ctx: CheckContext): Promise<Finding[]> {
  const tool = await nodeTool(ctx, 'typescript', 'tsc');
  const seen = new Map<string, Finding>();
  for (const tsconfig of tsconfigs(ctx)) {
    const cwd = join(ctx.root, posix.dirname(tsconfig));
    const toRepo = (file: string): string =>
      relative(ctx.root, resolve(cwd, file)).split(sep).join('/');
    const args = ['--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'];
    const result = await runTool(ctx, tool, args, { cwd });
    const diagnostics = parseTsc(result.stdout);
    if (result.code !== 0 && diagnostics.length === 0) {
      throw new EngineError(`tsc -p ${tsconfig} exited ${result.code}:\n${tail(result)}`);
    }
    for (const diagnostic of diagnostics) {
      const finding = tscFinding(diagnostic, toRepo, tsconfig);
      seen.set(identity(finding), finding);
    }
  }
  return [...seen.values()];
}

export const typesCheck: Check = {
  id: 'ts/types',
  tier: 'commit',
  scope: 'component',
  langs: ['ts'],
  title: 'TypeScript compiler',
  applies: (ctx) => (tsconfigs(ctx).length > 0 ? APPLIES : skip('no tsconfig.json')),
  run,
};
