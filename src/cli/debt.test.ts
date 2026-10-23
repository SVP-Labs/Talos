import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { debtWith } from './debt.js';
import type { Io } from './io.js';
import type { Check } from '../core/check.js';
import type { Pack } from '../core/pack.js';
import type { Exec } from '../exec/exec.js';
import { tempRepo, testEngine } from '../testing/engine.js';

const run = promisify(execFile);

/**
 * Runs programs without a stdin pipe: a git command that exits before its stdin is closed makes
 * the engine's own exec raise EPIPE outside any promise.
 */
const quietExec: Exec = async (command, args, options) => {
  try {
    const done = await run(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    return { code: 0, stdout: done.stdout, stderr: done.stderr };
  } catch (error) {
    const failed = z
      .object({
        code: z.number().catch(1),
        stdout: z.string().catch(''),
        stderr: z.string().catch(''),
      })
      .parse(error);
    return failed;
  }
};

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await tempRepo(files);
  const git = (...args: string[]): Promise<unknown> => run('git', args, { cwd: root });
  await git('init', '-q', '-b', 'main');
  await git('add', '.');
  await git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  return root;
}

function counting(calls: string[]): Pack {
  const check = (id: string): Check => ({
    id,
    tier: 'commit',
    scope: 'repo',
    title: id,
    applies: () => ({ applies: true }),
    run: (ctx) => {
      calls.push(`${id}:${ctx.side}`);
      return Promise.resolve([
        {
          rule: 'eslint/complexity',
          message: 'too complex',
          location: { file: 'src/a.ts', line: 1 },
        },
      ]);
    },
  });
  return { name: 'test', checks: [check('test/lint'), check('test/mutation')] };
}

async function talos(
  root: string,
  packs: Pack[],
  ...argv: string[]
): Promise<{ code: number; out: string }> {
  let out = '';
  const io: Io = {
    cwd: root,
    env: {},
    out: (text) => {
      out += text;
    },
    err: () => undefined,
  };
  const code = await debtWith(() => ({ ...testEngine(packs), exec: quietExec }))(argv, io);
  return { code, out };
}

describe('talos debt', () => {
  it('runs every check but mutation at the default branch, alone, caches it, cleans up', async () => {
    const root = await repoWith({
      'talos.yml': 'name: T\nprefix: T\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    const calls: string[] = [];
    const first = await talos(root, [counting(calls)], '--json');
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toMatchObject({
      schema: 'talos.debt/1',
      counts: { total: 1, rules: 1, files: 1, faults: 0 },
      byFile: [{ file: 'src/a.ts', count: 1 }],
    });
    expect(calls).toEqual(['test/lint:alone']);
    const status = await run('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: root,
    });
    expect(status.stdout).toBe('');
    const again = await talos(root, [counting(calls)], '--out', join(root, 'debt.json'));
    expect(calls).toHaveLength(1);
    expect(again.out).toContain('1 finding(s)');
    const full: unknown = JSON.parse(await readFile(join(root, 'debt.json'), 'utf8'));
    expect(full).toMatchObject({ findings: [{ rule: 'eslint/complexity', file: 'src/a.ts' }] });
    expect(await readdir(join(root, '.talos', 'worktrees'))).toHaveLength(0);
  });

  it('exits 2 when a check fails to run, and keeps no cache of that run', async () => {
    const root = await repoWith({ 'talos.yml': 'name: T\nprefix: T\n' });
    const broken: Pack = {
      name: 'broken',
      checks: [
        {
          id: 'broken/lint',
          tier: 'head',
          scope: 'repo',
          title: 'b',
          applies: () => ({ applies: true }),
          run: () => Promise.reject(new Error('tool missing')),
        },
      ],
    };
    expect((await talos(root, [broken], '--ref', 'HEAD')).code).toBe(2);
    await expect(readdir(join(root, '.talos', 'cache'))).rejects.toThrow();
  });

  it('says so when there is no default branch to read', async () => {
    const root = await tempRepo({ 'talos.yml': 'name: T\nprefix: T\n' });
    await run('git', ['init', '-q', '-b', 'trunk'], { cwd: root });
    await expect(talos(root, [])).rejects.toThrow(/no default branch/);
  });
});
