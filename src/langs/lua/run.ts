import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { component, componentDir, installedProgram, type Place, scriptEnv } from './paths.js';
import type { CheckContext } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import type { ExecOptions, ExecResult } from '../../exec/exec.js';

/** What running the tree's programs needs. */
export type ToolContext = Place & Pick<CheckContext, 'exec' | 'scratch'>;

/** A Lua check's context, its component set. */
export type Bound = CheckContext & Place;

export const bind = (ctx: CheckContext): Bound => ({ ...ctx, component: component(ctx) });

/**
 * Runs a program from the component's tree (`lua`, `luarocks`, or a rock's command), in the
 * component's directory unless told otherwise.
 */
export async function runTree(
  ctx: ToolContext,
  name: string,
  args: readonly string[],
  options: Partial<Pick<ExecOptions, 'cwd' | 'timeoutMs' | 'env'>> = {},
): Promise<ExecResult> {
  return ctx.exec(await installedProgram(ctx, name), args, { cwd: componentDir(ctx), ...options });
}

/** An engine error for a program that failed, ending with the last of what it printed. */
export function failed(what: string, result: ExecResult): EngineError {
  const printed = result.stderr.trim() === '' ? result.stdout : result.stderr;
  const last = printed.trim().split('\n').slice(-15).join('\n');
  return new EngineError(`${what} exited ${result.code}:\n${last}`);
}

/**
 * Runs one of Talos's Lua scripts with the tree's interpreter, in the component's directory,
 * with modules from the tree only. Returns its standard output; any failure is an engine error.
 */
export async function runScript(
  ctx: ToolContext,
  script: { readonly name: string; readonly source: string },
  args: readonly string[],
): Promise<string> {
  const path = join(ctx.scratch, script.name);
  await writeFile(path, script.source);
  const result = await runTree(ctx, 'lua', [path, ...args], { env: scriptEnv(ctx) });
  if (result.code !== 0) throw failed(`lua ${script.name}`, result);
  return result.stdout;
}

/** Text a tool printed as JSON. */
export function parseJson(text: string, what: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new EngineError(`${what} printed no readable JSON: ${text.trim().slice(0, 200)}`);
  }
}

/**
 * Splits arguments into runs that each stay under `limit` characters, since Windows starts the
 * rocks' `.bat` commands through cmd.exe, whose command line holds 8191 characters.
 */
export function chunks(items: readonly string[], limit = 6000): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const item of items) {
    if (current.length > 0 && length + item.length + 1 > limit) {
      out.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += item.length + 1;
  }
  if (current.length > 0) out.push(current);
  return out;
}
