import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { LUACHECK_BASE } from './configs.js';
import { fromTool, luaFiles } from './paths.js';
import { type Bound, chunks, failed, parseJson, runTree } from './run.js';
import { FORMATTER_MODULE, LUACHECK_FORMATTER } from './scripts/luacheck.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { ExecResult } from '../../exec/exec.js';

const event = z.object({
  code: z.string().regex(/^\d{3}$/),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
  endColumn: z.number().int().nonnegative(),
  message: z.string(),
});

const fileReport = z.object({
  file: z.string(),
  fatal: z.string(),
  error: z.string(),
  events: z.array(event),
});

const report = z.object({ files: z.array(fileReport) });

export type LuacheckEvent = z.infer<typeof event>;
export type LuacheckFile = { readonly file: string; readonly events: readonly LuacheckEvent[] };

/** What one luacheck run found: per file, or why the project's configuration couldn't load. */
export type LuacheckRun =
  | { readonly kind: 'checked'; readonly files: readonly LuacheckFile[] }
  | { readonly kind: 'config'; readonly message: string };

/** Unused variables, values and labels, unreachable code: the warnings lua/deadcode owns. */
const DEAD_CODE = /^(?:131|21[123]|23[123]|241|31[1234]|331|511|521)$/;

export function isDeadCode(code: string): boolean {
  return DEAD_CODE.test(code);
}

/** The JSON Talos's formatter prints; a file luacheck couldn't read is an engine error. */
export function parseLuacheck(stdout: string): LuacheckFile[] {
  const parsed = report.safeParse(parseJson(stdout.trim(), 'luacheck'));
  if (!parsed.success) throw new EngineError('luacheck printed an unknown shape');
  return parsed.data.files.map((file) => {
    if (file.fatal !== '') {
      throw new EngineError(`luacheck couldn't check ${file.file}: ${file.fatal} ${file.error}`);
    }
    return { file: file.file, events: file.events };
  });
}

const CONFIG_ERROR = /^Critical error: (?:Couldn't load configuration from|in config loaded from) /;

/**
 * luacheck exits 4 for a critical error. One loading the configuration is the project's to fix
 * (its file failed, or set an option luacheck rejects); any other is Talos's.
 */
export function configError(result: ExecResult): string | undefined {
  if (result.code !== 4) return undefined;
  const first = result.stderr.trim().split('\n')[0] ?? '';
  return CONFIG_ERROR.test(first) ? first.replace(/^Critical error: /, '') : undefined;
}

/** luacheck's words as a sentence. */
export function sentence(message: string): string {
  const text = message.trim();
  const capital = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** `luacheck/W211`, `luacheck/E011`: the code as luacheck prints it with `--codes`. */
export function ruleOf(code: string): string {
  return `luacheck/${code.startsWith('0') ? 'E' : 'W'}${code}`;
}

export function eventFinding(ctx: Bound, file: string, e: LuacheckEvent): Finding {
  return {
    rule: ruleOf(e.code),
    message: sentence(e.message),
    location: { file: fromTool(ctx, file), line: e.line, endLine: e.line, column: e.column },
  };
}

async function writeFormatter(ctx: Bound): Promise<string> {
  const dir = join(ctx.scratch, 'luacheck-formatter');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, LUACHECK_FORMATTER.name), LUACHECK_FORMATTER.source);
  return dir;
}

async function check(ctx: Bound, dir: string, files: readonly string[]): Promise<ExecResult> {
  const options = ['--config', LUACHECK_BASE, '--formatter', FORMATTER_MODULE, '--no-cache'];
  const args = [...options, '--', ...files];
  return runTree(ctx, 'luacheck', args, { env: { LUA_PATH_5_4: `${dir}/?.lua;;` } });
}

/**
 * luacheck over every Lua file of the component, with the generated `.luacheckrc` (which loads
 * the project's file). Exit codes 1 to 3 mean warnings, errors or fatal errors: findings.
 */
async function runLuacheck(ctx: Bound): Promise<LuacheckRun> {
  const files = luaFiles(ctx);
  const dir = await writeFormatter(ctx);
  const found: LuacheckFile[] = [];
  for (const batch of chunks(files)) {
    const result = await check(ctx, dir, batch);
    const config = configError(result);
    if (config !== undefined) return { kind: 'config', message: config };
    if (result.code > 3) throw failed('luacheck', result);
    found.push(...parseLuacheck(result.stdout));
  }
  return { kind: 'checked', files: found };
}

/** One luacheck run per component, shared by lua/lint and lua/deadcode. */
export async function luacheck(ctx: Bound): Promise<LuacheckRun> {
  return ctx.memo(`lua/luacheck:${ctx.component.root}`, () => runLuacheck(ctx));
}
