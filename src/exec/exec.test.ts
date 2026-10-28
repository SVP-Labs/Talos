import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExecError, batchCommand, exec, invocation } from './exec.js';

/** Arguments that would be syntax to a shell, to cmd.exe or to the C runtime. */
const HOSTILE = [
  'plain',
  '',
  'two words',
  '"quoted"',
  'a"b',
  String.raw`a\"b`,
  String.raw`a\\"b`,
  'C:\\dir\\',
  'C:\\dir\\\\',
  String.raw`C:\dir\ `,
  'a & calc',
  'a|b',
  '<in',
  '>out',
  '(x)',
  '^',
  'a^&b',
  '%PATH%',
  '%%',
  '100%',
  '%~dp0',
  '%cd:~,%',
  '!PATH!',
  'a,b;c=d',
  '\tab',
  'x" & calc & "y',
  '"&calc&"',
  '""',
  '$(id) `id` ;ls *',
  'ü 😀',
];

const BATCH = String.raw`C:\Program Files (x86)\nodejs\npm.cmd`;

/**
 * cmd.exe's percent expansion of a command line at its most dangerous: `%%` gives one `%` and
 * goes on from the second, `%cd:~,%` is the empty substring the guard relies on, and any other
 * name between two `%` is expanded, marked so a test sees it.
 */
function expandPercents(line: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const start = line.indexOf('%', at);
    const end = start < 0 ? -1 : line.indexOf('%', start + 1);
    if (end < 0) return out + line.slice(at);
    const name = line.slice(start + 1, end);
    out += line.slice(at, start);
    if (name === '') out += '%';
    else if (name !== 'cd:~,') out += `<${name}>`;
    at = name === '' ? end : end + 1;
  }
}

/** What cmd.exe reads outside quotes, where `& | < > ( ) ^` and its separators are syntax. */
function unquoted(line: string): string {
  let quoted = false;
  let out = '';
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (!quoted) out += char;
  }
  return out;
}

type Reading = { readonly args: string[]; word: string | undefined; quoted: boolean };

function backslashes(line: string, at: number, state: Reading): number {
  let end = at;
  while (line[end] === '\\') end += 1;
  const count = end - at;
  const quote = line[end] === '"';
  state.word = `${state.word ?? ''}${'\\'.repeat(quote ? Math.floor(count / 2) : count)}`;
  if (!quote || count % 2 === 0) return end;
  state.word += '"';
  return end + 1;
}

function quote(line: string, at: number, state: Reading): number {
  if (state.quoted && line[at + 1] === '"') {
    state.word = `${state.word ?? ''}"`;
    return at + 2;
  }
  state.quoted = !state.quoted;
  state.word ??= '';
  return at + 1;
}

function other(char: string, state: Reading): void {
  if (state.quoted || (char !== ' ' && char !== '\t')) {
    state.word = `${state.word ?? ''}${char}`;
    return;
  }
  if (state.word !== undefined) state.args.push(state.word);
  state.word = undefined;
}

/** The arguments a program built on the Microsoft C runtime reads from its command line. */
function crtArgs(line: string): string[] {
  const state: Reading = { args: [], word: undefined, quoted: false };
  let at = 0;
  while (at < line.length) {
    const char = line.charAt(at);
    if (char === '\\') at = backslashes(line, at, state);
    else if (char === '"') at = quote(line, at, state);
    else {
      other(char, state);
      at += 1;
    }
  }
  if (state.word !== undefined) state.args.push(state.word);
  return state.args;
}

/**
 * What a batch program started through `cmd /s /c` gets, and what the program it passes `%*` on
 * to gets: cmd drops the outer quotes, expands percents once, and runs the batch file, whose own
 * line cmd reads again with the arguments' text in it, unexpanded.
 */
function delivered(args: readonly string[]): { outside: string[]; forwarded: string[] } {
  const line = expandPercents(batchCommand(BATCH, args).slice(1, -1));
  const passed = line.slice(line.indexOf('"', 1) + 1);
  const shim = String.raw`"C:\nodejs\node.exe" "C:\nodejs\npm-cli.js"${passed}`;
  return { outside: [unquoted(line), unquoted(shim)], forwarded: crtArgs(shim).slice(2) };
}

describe('batchCommand', () => {
  it('quotes the program and every argument as one word each', () => {
    expect(batchCommand(String.raw`C:\t\npm.cmd`, ['a b', 'x"y', '%P%', 'd\\', ''])).toBe(
      String.raw`""C:\t\npm.cmd" "a b" "x""y" "%%cd:~,%P%%cd:~,%" "d\\" """`,
    );
  });

  it('keeps every hostile argument text through cmd.exe and a batch file passing it on', () => {
    for (const arg of HOSTILE) {
      expect(delivered([arg]), JSON.stringify(arg)).toEqual({
        outside: [' ', '  '],
        forwarded: [arg],
      });
    }
    expect(delivered(HOSTILE).forwarded).toEqual(HOSTILE);
  });

  it('refuses a line break or another control character, which cmd.exe cannot carry', () => {
    for (const arg of ['a\nb', 'a\rb', 'a\r\nb', '\u0000', '\u001A', '\u001B[31m']) {
      expect(() => batchCommand(BATCH, ['ok', arg])).toThrow(ExecError);
      expect(() => batchCommand(BATCH, ['ok', arg])).toThrow(/argument 2 to a batch program/);
    }
  });

  it("refuses a command longer than cmd.exe's line", () => {
    expect(batchCommand('x.cmd', ['a'.repeat(8179)])).toHaveLength(8191);
    expect(() => batchCommand('x.cmd', ['a'.repeat(8180)])).toThrow(/longer than cmd.exe's 8191/);
  });
});

describe('invocation', () => {
  it('starts a program itself, with its arguments as they are, everywhere but a batch file', () => {
    expect(invocation('npm', ['a & b'], 'linux')).toEqual({
      file: 'npm',
      args: ['a & b'],
      verbatim: false,
    });
    expect(invocation(String.raw`C:\t\git.exe`, ['a & b'], 'win32')).toEqual({
      file: String.raw`C:\t\git.exe`,
      args: ['a & b'],
      verbatim: false,
    });
    expect(invocation('/t/run.cmd', ['a & b'], 'darwin').file).toBe('/t/run.cmd');
  });

  it('starts a Windows batch file through cmd.exe, with no AutoRun and no ! expansion', () => {
    for (const program of [String.raw`C:\t\NPM.CMD`, String.raw`C:\t\busted.bat`]) {
      expect(invocation(program, ['a & b'], 'win32')).toEqual({
        file: process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/e:on', '/v:off', '/s', '/c', `""${program}" "a & b""`],
        verbatim: true,
      });
    }
    expect(() => invocation(String.raw`C:\t\run.cmd`, ['a\nb'], 'win32')).toThrow(ExecError);
  });
});

describe('exec', () => {
  const options = { cwd: tmpdir() };
  const print = 'console.log(JSON.stringify(process.argv.slice(1)))';

  it('gives the program every argument as it is, with no shell to read them', async () => {
    const run = await exec(process.execPath, ['-e', print, ...HOSTILE], options);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(HOSTILE);
  });

  it('reports the exit code and output, and feeds the input', async () => {
    const script = 'process.stdin.pipe(process.stdout); process.exitCode = 3';
    // No warning of Node's own, such as one a proxy setting in the environment prints.
    const args = ['--no-warnings', '-e', script];
    expect(await exec(process.execPath, args, { ...options, input: 'in' })).toEqual({
      code: 3,
      stdout: 'in',
      stderr: '',
    });
  });

  it("throws when the program can't start or runs past its time", async () => {
    await expect(exec('talos-no-such-program', [], options)).rejects.toThrow(/could not start/);
    const hang = exec(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      ...options,
      timeoutMs: 100,
    });
    await expect(hang).rejects.toThrow(/timed out after 100 ms/);
  });
});

describe.skipIf(process.platform !== 'win32')('exec on a real Windows batch file', () => {
  const print = '-e "console.log(JSON.stringify(process.argv.slice(1)))"';
  const node = `"${process.execPath}"`;
  const shims = {
    'line.cmd': `@${node} ${print} %*\r\n`,
    'block.cmd': `@IF EXIST ${node} (\r\n  ${node} ${print} %*\r\n)\r\n`,
  };

  it('hands every hostile argument through a batch file passing %* on, as it is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talos-exec-'));
    try {
      for (const [name, text] of Object.entries(shims)) {
        await writeFile(join(dir, name), text);
        const run = await exec(join(dir, name), HOSTILE, { cwd: dir });
        expect({ name, code: run.code, args: JSON.parse(run.stdout) as unknown }).toEqual({
          name,
          code: 0,
          args: HOSTILE,
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('finds a shim on PATH by its bare name, as pnpm, npm and npx are installed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talos-exec-'));
    // The PATH key as the process has it, so the child's environment holds one PATH, not two.
    const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
    const env = { [key]: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    try {
      await writeFile(join(dir, 'talos-shim.CMD'), shims['line.cmd']);
      const run = await exec('talos-shim', HOSTILE, { cwd: dir, env });
      expect({ code: run.code, args: JSON.parse(run.stdout) as unknown }).toEqual({
        code: 0,
        args: HOSTILE,
      });
      await expect(exec('talos-no-such-shim', [], { cwd: dir, env })).rejects.toThrow(
        /talos-no-such-shim could not start: spawn talos-no-such-shim ENOENT/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
