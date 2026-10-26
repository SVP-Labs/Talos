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

/**
 * Runs a program without a shell (see `invocation`); never throws for a non-zero exit, only when
 * it can't start or can't be given its arguments.
 */
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
 * Windows starts `npx` or `pnpm` only through their `.cmd` shims, which `spawn` won't find on
 * PATH by their bare names; this finds the shim, which `invocation` then hands to cmd.exe.
 */
async function resolveCommand(
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

/** The longest command cmd.exe reads. */
const CMD_LIMIT = 8191;

/** A `%` written so no name follows it: `%%` reads as one `%`, then `%cd:~,%` as nothing. */
const PERCENT = '%%cd:~,%';

/** Whether cmd.exe can carry a character in an argument: other control characters end its line. */
function passable(char: string): boolean {
  return char === '\t' || (char.codePointAt(0) ?? 0) >= 0x20;
}

/**
 * One word of a batch program's command line, in double quotes so cmd reads `& | < > ( ) ^ , ; =`
 * and spaces inside it as text. A quote inside it is doubled, which leaves cmd's quoting where
 * it was however many times the line is read (a batch file passing `%*` on reads it again), and
 * which the C runtime reads back as one quote; backslashes are doubled where they come before a
 * quote, as the C runtime reads them. Each `%` is cut off from the text after it, so cmd
 * expands no `%name%` in it.
 */
function batchWord(word: string, index: number, command: string): string {
  let out = '"';
  let backslashes = 0;
  for (const char of word) {
    if (!passable(char)) {
      throw new ExecError(
        `${command}: cmd.exe can't pass argument ${String(index)} to a batch program, as it holds a line break or a control character`,
      );
    }
    if (char === '"') out += `${'\\'.repeat(backslashes)}""`;
    else out += char === '%' ? PERCENT : char;
    backslashes = char === '\\' ? backslashes + 1 : 0;
  }
  return `${out}${'\\'.repeat(backslashes)}"`;
}

/**
 * The command cmd.exe runs for a batch program, as `/s /c` takes it: in quotes, the program and
 * each argument quoted as one word that cmd never reads as syntax.
 */
export function batchCommand(command: string, args: readonly string[]): string {
  const words = [command, ...args].map((word, index) => batchWord(word, index, command));
  const line = `"${words.join(' ')}"`;
  if (line.length > CMD_LIMIT) {
    throw new ExecError(
      `${command}: a command line of ${String(line.length)} characters is longer than cmd.exe's ${String(CMD_LIMIT)}`,
    );
  }
  return line;
}

type Invocation = { readonly file: string; readonly args: string[]; readonly verbatim: boolean };

/**
 * How a program starts: directly, with no shell, except a batch program on Windows, which only
 * cmd.exe can run. cmd.exe gets no AutoRun commands (`/d`), command extensions on (`/e:on`, for
 * the `%` guard), `!name!` expansion off (`/v:off`), and the quoted command as written (`/s /c`).
 */
export function invocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Invocation {
  if (platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(command)) {
    return { file: command, args: [...args], verbatim: false };
  }
  const shell = process.env.ComSpec ?? 'cmd.exe';
  const switches = ['/d', '/e:on', '/v:off', '/s', '/c'];
  return { file: shell, args: [...switches, batchCommand(command, args)], verbatim: true };
}

export const exec: Exec = async (command, args, options) => {
  const env = { ...process.env, ...options.env };
  const run = invocation(await resolveCommand(command, env), args);
  return new Promise((resolve, reject) => {
    const child = spawn(run.file, run.args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: run.verbatim,
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
