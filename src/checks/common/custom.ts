import { access } from 'node:fs/promises';
import { isAbsolute, posix, relative, win32 } from 'node:path';
import { z } from 'zod';
import {
  APPLIES,
  type Check,
  type CheckContext,
  EngineError,
  type Os,
  skip,
  type Tier,
} from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { ExecResult } from '../../exec/exec.js';

/** One line of a custom check's output (`talos.yml`'s `checks.<id>`): one finding. */
const reported = z.object({
  rule: z.string().regex(/^\w[\w.:/-]*$/, 'must be a rule id: letters, digits, _ . : / -'),
  file: z.string().min(1),
  line: z.number().int().positive(),
  message: z.string().trim().min(1),
});

const MAX_QUOTED = 200;

function quoted(text: string): string {
  return text.length <= MAX_QUOTED ? text : `${text.slice(0, MAX_QUOTED - 1)}…`;
}

/** A reported path made repository-relative, or undefined when it lies outside the repository. */
export function insideRepo(root: string, file: string): string | undefined {
  const local = isAbsolute(file) ? relative(root, file) : file;
  const normal = posix.normalize(local.replaceAll('\\', '/')).replace(/^\.\//, '');
  const outside =
    normal === '..' ||
    normal.startsWith('../') ||
    posix.isAbsolute(normal) ||
    win32.isAbsolute(normal);
  return outside || normal === '.' ? undefined : normal;
}

function parseLine(id: string, root: string, text: string, number: number): Finding {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EngineError(`custom check ${id}: output line ${number} is not JSON: ${quoted(text)}`);
  }
  const parsed = reported.safeParse(raw);
  if (!parsed.success) {
    const problem = z.prettifyError(parsed.error);
    const expected = '{rule, file, line, message}';
    throw new EngineError(
      `custom check ${id}: output line ${number} is not ${expected}: ${problem}`,
    );
  }
  const file = insideRepo(root, parsed.data.file);
  if (file === undefined) {
    throw new EngineError(
      `custom check ${id}: ${quoted(parsed.data.file)} is not a file in the repository`,
    );
  }
  return {
    rule: `custom/${id}/${parsed.data.rule}`,
    message: parsed.data.message,
    location: { file, line: parsed.data.line },
  };
}

/**
 * A custom check's findings: one JSON object `{rule, file, line, message}` per non-blank line
 * of its output. Anything else is an engine error naming the check, so a broken script never
 * passes for a clean one.
 */
export function customFindings(id: string, root: string, stdout: string): Finding[] {
  return stdout
    .split('\n')
    .map((text, index) => ({ text: text.trim(), number: index + 1 }))
    .filter(({ text }) => text !== '')
    .map(({ text, number }) => parseLine(id, root, text, number));
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * The bash that runs a custom check: Git Bash on Windows, found where Git for Windows installs
 * it, since the `bash.exe` Windows itself ships starts WSL instead.
 */
export async function bashFor(
  os: Os,
  env: Readonly<Record<string, string | undefined>>,
  present: (path: string) => Promise<boolean> = exists,
): Promise<string> {
  if (os !== 'windows') return 'bash';
  const programs = env.ProgramFiles ?? String.raw`C:\Program Files`;
  const gitBash = win32.join(programs, 'Git', 'bin', 'bash.exe');
  return (await present(gitBash)) ? gitBash : 'bash.exe';
}

function tail(result: ExecResult): string {
  return `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-15).join('\n');
}

async function runOne(ctx: CheckContext, id: string, command: string): Promise<Finding[]> {
  const bash = await bashFor(ctx.os, process.env);
  let result: ExecResult;
  try {
    result = await ctx.exec(bash, ['-c', command], { cwd: ctx.root });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineError(`custom check ${id} could not run: ${reason}`);
  }
  const findings = customFindings(id, ctx.root, result.stdout);
  if (result.code !== 0 && findings.length === 0) {
    throw new EngineError(
      `custom check ${id} exited ${result.code} with no findings:\n${tail(result)}`,
    );
  }
  return findings;
}

function declaredFor(
  ctx: { readonly config: CheckContext['config'] },
  tier: Tier,
): [string, string][] {
  return Object.entries(ctx.config.checks)
    .filter(([, check]) => check.scope === tier)
    .map(([id, check]) => [id, check.run]);
}

async function runDeclared(ctx: CheckContext, tier: Tier): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const [id, command] of declaredFor(ctx, tier)) {
    findings.push(...(await runOne(ctx, id, command)));
  }
  return findings;
}

function customCheck(tier: Tier): Check {
  return {
    id: `common/custom-${tier}`,
    tier,
    scope: 'repo',
    title: `the project's own ${tier}-tier checks from talos.yml`,
    applies: (ctx) =>
      declaredFor(ctx, tier).length > 0
        ? APPLIES
        : skip(`talos.yml declares no custom check with scope ${tier}`),
    run: (ctx) => runDeclared(ctx, tier),
  };
}

/** `talos.yml`'s `checks` with `scope: commit`, run on every commit, from the repository root. */
export const customCommitCheck = customCheck('commit');

/** `talos.yml`'s `checks` with `scope: head`, run at a PR's head and its base, from the root. */
export const customHeadCheck = customCheck('head');
