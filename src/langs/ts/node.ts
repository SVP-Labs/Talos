import { access, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { rootOf } from './files.js';
import { type CheckContext, EngineError } from '../../core/check.js';
import type { ExecResult } from '../../exec/exec.js';

const manifest = z.object({
  version: z.string(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
});

export type InstalledPackage = {
  /** Absolute directory of the package. */
  readonly dir: string;
  readonly version: string;
  readonly bin?: string | Readonly<Record<string, string>>;
};

/** A program a package installs, run with the Node that runs Talos rather than a shell shim. */
export type NodeTool = {
  readonly name: string;
  readonly script: string;
};

export async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Absolute path of the component's root in the checkout. */
export function componentDir(ctx: Pick<CheckContext, 'root' | 'component'>): string {
  return resolve(ctx.root, rootOf(ctx.component));
}

/** Directories from `start` up to `stop`, both included; `start` must be under `stop`. */
export function upwards(start: string, stop: string): string[] {
  const dirs: string[] = [];
  let dir = start;
  for (;;) {
    dirs.push(dir);
    if (dir === stop || relative(stop, dir).startsWith('..')) return dirs;
    const parent = dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

async function readManifest(dir: string): Promise<InstalledPackage | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = manifest.safeParse(raw);
  if (!parsed.success) return undefined;
  const { version, bin } = parsed.data;
  return bin === undefined ? { dir, version } : { dir, version, bin };
}

/**
 * The package as the component resolves it: its own `node_modules`, then each parent's up to the
 * repository root (a workspace hoists them there).
 */
export async function installedPackage(
  ctx: Pick<CheckContext, 'root' | 'component'>,
  name: string,
): Promise<InstalledPackage | undefined> {
  for (const dir of upwards(componentDir(ctx), resolve(ctx.root))) {
    const found = await readManifest(join(dir, 'node_modules', name));
    if (found !== undefined) return found;
  }
  return undefined;
}

export function binScript(pkg: InstalledPackage, bin: string): string | undefined {
  const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[bin];
  return entry === undefined ? undefined : join(pkg.dir, entry);
}

/** One of the component's own tools; a tool it doesn't have is an engine error naming the fix. */
export async function nodeTool(
  ctx: Pick<CheckContext, 'root' | 'component'>,
  name: string,
  bin: string,
): Promise<NodeTool> {
  const pkg = await installedPackage(ctx, name);
  const script = pkg === undefined ? undefined : binScript(pkg, bin);
  if (script === undefined) {
    throw new EngineError(
      `${name} is not installed in ${rootOf(ctx.component)}: add it to the component's ` +
        'devDependencies (talos adopt pins it) and commit the lockfile',
    );
  }
  return { name: bin, script };
}

/** Environment for tools whose output Talos parses: no colours, no prompts. */
export const TOOL_ENV: Readonly<Record<string, string>> = {
  FORCE_COLOR: '0',
  NO_COLOR: '1',
  CI: 'true',
};

export type RunOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

export async function runTool(
  ctx: Pick<CheckContext, 'root' | 'component' | 'exec'>,
  tool: NodeTool,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  try {
    return await ctx.exec(process.execPath, [tool.script, ...args], {
      cwd: options.cwd ?? componentDir(ctx),
      env: { ...TOOL_ENV, ...options.env },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineError(`${tool.name} could not run: ${reason}`);
  }
}

/** The last lines of a tool's output, for an engine error's message. */
export function tail(result: ExecResult, lines = 15): string {
  return `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-lines).join('\n');
}

/** An engine error for a tool whose output could not be read. */
export function unreadable(tool: string, result: ExecResult): EngineError {
  return new EngineError(
    `${tool} exited ${result.code} without a report Talos can read:\n${tail(result)}`,
  );
}

/** Maps in chunks, so reading thousands of files never runs out of file handles. */
export async function mapInChunks<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  size = 64,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(work))));
  }
  return results;
}

/** Splits arguments into runs that keep each command line well under Windows' limit. */
export function batches(items: readonly string[], maxChars = 24_000): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length > 0 && size + item.length + 1 > maxChars) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.length + 1;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Parses JSON a tool wrote, or throws an engine error naming the tool. */
export function parseJson(tool: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new EngineError(`${tool} wrote output that is not JSON: ${text.slice(0, 200)}`);
  }
}
