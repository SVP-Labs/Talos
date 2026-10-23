import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export type ExecOptions = {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to 30 minutes: a hung tool is an engine error, not a wait forever. */
  readonly timeoutMs?: number;
  readonly input?: string;
};

export type ExecResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Runs a program without a shell; never throws for a non-zero exit, only when it can't start. */
export type Exec = (
  command: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT = 30 * 60 * 1000;

export class ExecError extends Error {
  override readonly name = 'ExecError';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows starts `npx` or `pnpm` only through their `.cmd` shims, which `spawn` won't find
 * without a shell; this finds the shim on PATH so no shell is ever needed.
 */
export async function resolveCommand(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform !== 'win32' || extname(command) !== '' || isAbsolute(command)) return command;
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension.toLowerCase()}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return command;
}

function needsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function quoteForCmd(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

export const exec: Exec = async (command, args, options) => {
  const env = { ...process.env, ...options.env };
  const resolved = await resolveCommand(command, env);
  const shell = needsShell(resolved);
  const argv = shell ? args.map(quoteForCmd) : [...args];
  return new Promise((resolve, reject) => {
    const child = spawn(shell ? quoteForCmd(resolved) : resolved, argv, {
      cwd: options.cwd,
      env,
      shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new ExecError(`${command} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT} ms`),
      );
    }, options.timeoutMs ?? DEFAULT_TIMEOUT);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ExecError(`${command} could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    // A program that exits before reading its input closes the pipe; that is not an error here.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
};

/** Runs a command that must succeed, returning its standard output. */
export async function execOk(
  run: Exec,
  command: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-20).join('\n');
    throw new ExecError(`${command} ${args.join(' ')} exited ${result.code}:\n${detail}`);
  }
  return result.stdout;
}
