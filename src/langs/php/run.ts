import { join } from 'node:path';
import { component, componentDir, fileExists, inRepo, type Place } from './paths.js';
import type { CheckContext } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import type { ExecResult } from '../../exec/exec.js';

/** The PHP on the machine's PATH, which the gate's runner sets up. */
const PHP = 'php';

/** A component check's context with its component, which the engine always sets. */
export type Bound = CheckContext & Place;

export function bind(ctx: CheckContext): Bound {
  return { ...ctx, component: component(ctx) };
}

export type ToolContext = Pick<CheckContext, 'exec' | 'scratch'> & Place;

/** Environment for tools whose output Talos parses: no colours, no prompts, no debugger. */
const TOOL_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: '1',
  COLUMNS: '200',
  XDEBUG_MODE: 'off',
  COMPOSER_NO_INTERACTION: '1',
};

/** The Composer package that installs each program Talos runs from `vendor/bin`. */
const PACKAGES: Readonly<Record<string, string>> = {
  deptrac: 'deptrac/deptrac',
  infection: 'infection/infection',
  pest: 'pestphp/pest',
  phpmd: 'phpmd/phpmd',
  phpstan: 'phpstan/phpstan',
  pint: 'laravel/pint',
};

export function notInstalled(place: Pick<Place, 'component'>, name: string): EngineError {
  return new EngineError(
    `${name} is not installed in ${inRepo(place.component.root, 'vendor')}: add it to ` +
      'require-dev at the version Talos pins and commit composer.lock',
  );
}

/** A file under the component's `vendor/`, which must exist. */
export async function vendorFile(
  place: Pick<Place, 'root' | 'component'>,
  path: string,
  pkg: string,
): Promise<string> {
  const file = join(componentDir(place), 'vendor', ...path.split('/'));
  if (await fileExists(file)) return file;
  throw notInstalled(place, pkg);
}

/** A program from the component's `vendor/bin`, which Composer installs as a PHP script. */
export async function vendorBin(
  place: Pick<Place, 'root' | 'component'>,
  name: string,
): Promise<string> {
  return vendorFile(place, `bin/${name}`, PACKAGES[name] ?? name);
}

export type RunOptions = {
  /** Defaults to the component's directory. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** PHP settings for this run, as `-d name=value`. */
  readonly ini?: Readonly<Record<string, string>>;
  readonly input?: string;
};

/** Runs PHP with the given arguments; PHP missing from the machine is an engine error. */
export async function runPhp(
  ctx: Pick<ToolContext, 'exec' | 'root' | 'component'>,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  const ini = Object.entries({ memory_limit: '-1', ...options.ini }).flatMap(([key, value]) => [
    '-d',
    `${key}=${value}`,
  ]);
  try {
    return await ctx.exec(PHP, [...ini, ...args], {
      cwd: options.cwd ?? componentDir(ctx),
      env: { ...TOOL_ENV, ...options.env },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.input === undefined ? {} : { input: options.input }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineError(`PHP could not run: ${reason}`);
  }
}

/** Runs one of the component's own tools from `vendor/bin`. */
export async function runVendorTool(
  ctx: Pick<ToolContext, 'exec' | 'root' | 'component'>,
  name: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  return runPhp(ctx, [await vendorBin(ctx, name), ...args], options);
}

/** A tool's message as a sentence: trimmed, with its full stop. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The end of a tool's output, errors first, for an engine error's message. */
export function tail(result: ExecResult, count = 15): string {
  const lines = [result.stderr, result.stdout].join('\n').trim().split('\n');
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

/** An engine error for a tool that exited without output Talos can read. */
export function failed(what: string, result: ExecResult): EngineError {
  return new EngineError([`${what} exited ${result.code}:`, tail(result)].join('\n'));
}

/** Text a tool printed as JSON, from its first brace on; `what` names it in the error. */
export function jsonFrom(text: string, what: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text.slice(Math.max(0, text.indexOf('{'))));
  } catch {
    throw new EngineError(`${what} printed no JSON Talos can read`);
  }
  return value;
}
