import { delimiter, dirname } from 'node:path';
import { component, componentDir, type Place } from './paths.js';
import type { CheckContext } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import type { Exec, ExecResult } from '../../exec/exec.js';

/** A component check's context with its component, which the engine always sets. */
export type Bound = CheckContext & Place;

export function bind(ctx: CheckContext): Bound {
  return { ...ctx, component: component(ctx) };
}

export type ToolContext = Pick<CheckContext, 'exec'> & Pick<Place, 'root' | 'component'>;

export type RunOptions = {
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

export const HOUR = 60 * 60 * 1000;

/** Colour off and progress quiet, so what a tool prints can be read. */
const PLAIN = { CARGO_TERM_COLOR: 'never', CARGO_TERM_PROGRESS_WHEN: 'never' };

/** Runs a program in the component's directory. */
export async function runIn(
  ctx: ToolContext,
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  return ctx.exec(command, args, {
    cwd: componentDir(ctx),
    env: { ...PLAIN, ...options.env },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/** Cargo, through the toolchain the component pins (rustup reads its rust-toolchain.toml). */
export async function cargo(
  ctx: ToolContext,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  return runIn(ctx, 'cargo', args, options);
}

/** The last lines of a tool's output, for an engine error's message. */
export function tail(result: ExecResult, lines = 15): string {
  return (result.stderr || result.stdout).trim().split('\n').slice(-lines).join('\n');
}

export function failed(what: string, result: ExecResult): EngineError {
  return new EngineError(`${what} exited ${result.code}:\n${tail(result)}`);
}

/**
 * The environment with the directories of the given tools first on PATH, under the name the
 * current environment already uses for it (Windows spells it `Path`).
 */
export function pathWith(
  env: Readonly<Record<string, string | undefined>>,
  tools: readonly string[],
): Record<string, string> {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const dirs = [...new Set(tools.map((tool) => dirname(tool)))];
  return { [key]: [...dirs, env[key] ?? ''].filter((part) => part !== '').join(delimiter) };
}

/** Starts a cargo subcommand's own binary, taken from `tools.lock`, as cargo would. */
export async function cargoTool(
  ctx: ToolContext & { readonly exec: Exec },
  tool: { readonly path: string; readonly subcommand: string },
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  return runIn(ctx, tool.path, [tool.subcommand, ...args], options);
}
