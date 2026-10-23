import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mutmutRunner } from './mutation.js';
import { parseConfig } from '../../config/load.js';
import { type CheckContext, EngineError, type Os } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { ExecResult } from '../../exec/exec.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

const OPS = [
  '"""Arithmetic."""',
  '',
  '# Adds.',
  'def add(a, b):',
  '    return a + b',
  '',
  'class Box:',
  '    def area(self):',
  '        return 1',
  '',
].join('\n');

const SOURCES = {
  'py/src/calc/__init__.py': '',
  'py/src/calc/ops.py': OPS,
  'py/pyproject.toml': '[project]\nname = "calc"\n',
};

/** What Talos's span script prints for the sources. */
const SPANS = JSON.stringify({
  'src/calc/ops.py': {
    functions: [
      { name: 'add', owner: '', start: 4, end: 5 },
      { name: 'area', owner: 'Box', start: 8, end: 9 },
    ],
    docstrings: [[1, 1]],
  },
  'src/calc/__init__.py': null,
});

/** `mutmut results --all true` (mutmut 3.8.0). */
const RESULTS = [
  '    calc.ops.x_add__mutmut_1: killed',
  '    calc.ops.x_add__mutmut_2: survived',
  '    calc.ops.xǁBoxǁarea__mutmut_1: no tests',
  '    calc.ops.y__mutmut_1: survived',
  '    calc.ops.x_gone__mutmut_1: survived',
  '    other.x_f__mutmut_1: survived',
].join('\n');

const DIFF = '-    return a + b\n+    return a - b';

type Answers = { readonly run?: ExecResult; readonly results?: ExecResult };
type Seen = { readonly calls: string[][]; readonly cwd: string[] };

function answer(answers: Answers, args: readonly string[]): ExecResult {
  if (args[0] === 'run') return answers.run ?? { code: 0, stdout: 'done', stderr: '' };
  if (args[0] === 'results') return answers.results ?? { code: 0, stdout: RESULTS, stderr: '' };
  return { code: 0, stdout: `# ${args[1] ?? ''}\n${DIFF}`, stderr: '' };
}

async function runner(
  files: Readonly<Record<string, string>>,
  answers: Answers = {},
  os: Os = 'linux',
): Promise<{ ctx: CheckContext; seen: Seen }> {
  const venv = { 'py/.venv/bin/mutmut': '', 'py/.venv/bin/python': '' };
  const root = await tempRepo({ ...files, ...venv });
  const config = parseConfig(MINIMAL_CONFIG);
  const seen: Seen = { calls: [], cwd: [] };
  const ctx: CheckContext = {
    root,
    sha: '0'.repeat(40),
    exec: (command, args, options) => {
      const python = command.endsWith('python');
      seen.calls.push([python ? 'python' : 'mutmut', ...args]);
      seen.cwd.push(options.cwd);
      return Promise.resolve(
        python ? { code: 0, stdout: SPANS, stderr: '' } : answer(answers, args),
      );
    },
    tools: { path: (name) => Promise.resolve(`/tools/${name}`), version: () => '1.0.0' },
    scratch: await mkdtemp(join(tmpdir(), 'talos-mutmut-')),
    log: silentLogger,
    os,
    facts: repoFacts(Object.keys(files), config.exclude),
    config,
    side: 'alone',
    tiers: ['commit', 'head'],
    memo: (_key, compute) => compute(),
    component: { lang: 'py', root: 'py', os: ['linux'] },
  };
  return { ctx, seen };
}

async function report(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('mutmutRunner', () => {
  it("mutates the requested functions in a copy and reports each mutant's fate and function", async () => {
    const { ctx, seen } = await runner(SOURCES);
    const out = await mutmutRunner.run(ctx, [
      'py/src/calc/ops.py',
      'py/pyproject.toml',
      'web/a.ts',
    ]);
    expect(out.format).toBe('mutmut');
    expect(out.base).toBe(join(ctx.root, 'py'));
    const work = join(ctx.scratch, 'work');
    expect(seen.calls.find((c) => c[1] === 'run')).toEqual([
      'mutmut',
      'run',
      'calc.ops.x_*',
      'calc.ops.xǁ*',
    ]);
    expect(seen.cwd.at(-1)).toBe(work);
    expect(await readFile(join(work, 'pyproject.toml'), 'utf8')).toContain(
      'source_paths = [ "src" ]',
    );
    await expect(access(join(work, '.venv'))).rejects.toThrow();
    const file = 'src/calc/ops.py';
    expect(await report(out.path)).toEqual({
      format: 'talos-mutmut/1',
      mutants: [
        { name: 'calc.ops.x_add__mutmut_1', file, status: 'killed', functionLine: 3, diff: '' },
        { name: 'calc.ops.x_add__mutmut_2', file, status: 'survived', functionLine: 3, diff: DIFF },
        {
          name: 'calc.ops.xǁBoxǁarea__mutmut_1',
          file,
          status: 'no tests',
          functionLine: 8,
          diff: DIFF,
        },
        {
          name: 'calc.ops.x_gone__mutmut_1',
          file,
          status: 'survived',
          functionLine: 0,
          diff: DIFF,
        },
      ],
    });
  });

  it("leaves mutmut's own configuration alone, and reports nothing when nothing matches", async () => {
    const files = { ...SOURCES, 'py/setup.cfg': '[mutmut]\npaths_to_mutate = src/\n' };
    const nothing = { code: 1, stdout: '', stderr: 'nothing matches calc.ops.x_*' };
    const { ctx } = await runner(files, { run: nothing });
    const out = await mutmutRunner.run(ctx, ['py/src/calc/ops.py']);
    expect(await readFile(join(ctx.scratch, 'work', 'pyproject.toml'), 'utf8')).toBe(
      '[project]\nname = "calc"\n',
    );
    expect(await report(out.path)).toEqual({ format: 'talos-mutmut/1', mutants: [] });
  });

  it('writes a pyproject.toml for the copy of a project that has none', async () => {
    const { 'py/pyproject.toml': _pyproject, ...files } = SOURCES;
    const { ctx } = await runner(files);
    await mutmutRunner.run(ctx, ['py/src/calc/ops.py']);
    expect(await readFile(join(ctx.scratch, 'work', 'pyproject.toml'), 'utf8')).toContain(
      '[tool.mutmut]',
    );
  });

  it('runs nothing when no Python file is asked for', async () => {
    const { ctx, seen } = await runner(SOURCES);
    const out = await mutmutRunner.run(ctx, ['py/pyproject.toml']);
    expect(seen.calls).toEqual([]);
    expect(await report(out.path)).toEqual({ format: 'talos-mutmut/1', mutants: [] });
  });

  it("is an engine error when mutmut can't run or list its mutants, or on Windows", async () => {
    const crashed = await runner(SOURCES, { run: { code: 1, stdout: '', stderr: 'Traceback' } });
    await expect(mutmutRunner.run(crashed.ctx, ['py/src/calc/ops.py'])).rejects.toThrow(
      'mutmut run exited 1',
    );
    const unlisted = await runner(SOURCES, { results: { code: 2, stdout: '', stderr: 'none' } });
    await expect(mutmutRunner.run(unlisted.ctx, ['py/src/calc/ops.py'])).rejects.toThrow(
      'mutmut results exited 2',
    );
    const windows = await runner(SOURCES, {}, 'windows');
    await expect(mutmutRunner.run(windows.ctx, ['py/src/calc/ops.py'])).rejects.toThrow(
      new EngineError('mutmut runs on Linux and macOS only'),
    );
  });
});
