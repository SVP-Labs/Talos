import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { component, venvTool } from './paths.js';
import type { CheckContext } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import { componentDir, type Place } from '../../core/component.js';
import { failed, tail } from '../../core/component.js';
import type { ExecResult } from '../../exec/exec.js';

export { failed, tail };

export type ToolContext = Pick<CheckContext, 'exec' | 'scratch'> & Place;

/** A component check's context with its component, which the engine always sets. */
export type Bound = CheckContext & Place;

export function bind(ctx: CheckContext): Bound {
  return { ...ctx, component: component(ctx) };
}

export type RunOptions = {
  /** Defaults to the component's directory. */
  readonly cwd?: string;
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
};

/** Runs a console script from the component's virtual environment. */
export async function runTool(
  ctx: ToolContext,
  name: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  const tool = await venvTool(ctx, name);
  return ctx.exec(tool, args, {
    cwd: options.cwd ?? componentDir(ctx),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

/**
 * Runs one of Talos's own Python scripts with the component's interpreter, isolated (`-I`) so
 * nothing in the repository can shadow the standard library it imports.
 */
export async function runScript(
  ctx: ToolContext,
  name: string,
  script: string,
  input: string,
): Promise<string> {
  const path = join(ctx.scratch, name);
  await writeFile(path, script);
  const result = await runTool(ctx, 'python', ['-I', path], { input });
  if (result.code !== 0) throw failed(`python ${name}`, result);
  return result.stdout;
}

/** Text a tool printed as JSON, from its first brace or bracket on. */
export function jsonFrom(text: string, what: string): unknown {
  const start = text.search(/[[{]/);
  try {
    const value: unknown = JSON.parse(start < 0 ? text : text.slice(start));
    return value;
  } catch {
    throw new EngineError(`${what} printed no readable JSON: ${text.trim().slice(0, 200)}`);
  }
}
