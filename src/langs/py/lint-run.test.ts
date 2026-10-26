import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';
import type { Bound } from './run.js';
import { parseConfig } from '../../config/load.js';
import { EngineError } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { ExecResult } from '../../exec/exec.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

/** A function from line 3 to line 72: seventy lines, ten over the limit. */
const LONG = [
  '"""Calculations."""',
  '',
  'def classify(x):',
  ...Array.from({ length: 69 }, () => '    x += 1'),
  '',
].join('\n');

const FILES = {
  'py/src/demo/__init__.py': '',
  'py/src/demo/calc.py': LONG,
  'py/src/demo/types.pyi': 'import os\n',
  'py/tests/test_calc.py': LONG.replace('def classify', 'def test_classify'),
};

const SPANS = JSON.stringify({
  'src/demo/__init__.py': { functions: [], docstrings: [] },
  'src/demo/calc.py': {
    functions: [{ name: 'classify', owner: '', start: 3, end: 72 }],
    docstrings: [[1, 1]],
  },
  'tests/test_calc.py': {
    functions: [{ name: 'test_classify', owner: '', start: 3, end: 72 }],
    docstrings: [[1, 1]],
  },
});

/** ruff 0.17.2's JSON: a function-level rule on a name, and a rule on a stub, by relative path. */
function ruffJson(root: string): string {
  return JSON.stringify([
    {
      code: 'C901',
      end_location: { column: 12, row: 3 },
      filename: join(root, 'py', 'src', 'demo', 'calc.py'),
      location: { column: 5, row: 3 },
      message: '`classify` is too complex (14 > 12)',
      url: 'https://docs.astral.sh/ruff/rules/complex-structure',
    },
    {
      code: 'F401',
      end_location: { column: 10, row: 1 },
      filename: 'src/demo/types.pyi',
      location: { column: 8, row: 1 },
      message: '`os` imported but unused',
      url: null,
    },
  ]);
}

/** complexipy 8.1.0's SARIF for one function over the limit. */
function complexipySarif(root: string): string {
  const uri = join(root, 'py', 'src', 'demo', 'calc.py');
  const location = {
    logicalLocations: [{ kind: 'function', name: 'classify' }],
    physicalLocation: { artifactLocation: { uri }, region: { startLine: 3, endLine: 72 } },
  };
  const message = {
    text: "Function 'classify' has a cognitive complexity of 21, which exceeds the maximum allowed complexity of 15.",
  };
  return JSON.stringify({
    runs: [{ results: [{ ruleId: 'CC001', locations: [location], message }] }],
  });
}

type Answers = { readonly ruff?: ExecResult; readonly complexipyWrites?: boolean };
type Call = { readonly tool: string; readonly args: readonly string[]; readonly cwd: string };

async function judge(
  files: Readonly<Record<string, string>>,
  answers: Answers = {},
): Promise<{
  findings: Awaited<ReturnType<typeof lint>>;
  calls: Call[];
  root: string;
  scratch: string;
}> {
  const venv = {
    'py/.venv/bin/ruff': '',
    'py/.venv/bin/complexipy': '',
    'py/.venv/bin/python': '',
  };
  const root = await tempRepo({ ...files, ...venv });
  const scratch = await mkdtemp(join(tmpdir(), 'talos-py-lint-'));
  const config = parseConfig(MINIMAL_CONFIG);
  const calls: Call[] = [];
  const ctx: Bound = {
    root,
    sha: '0'.repeat(40),
    exec: async (command, args, options) => {
      const tool = command.split(/[\\/]/).at(-1) ?? '';
      calls.push({ tool, args, cwd: options.cwd });
      if (tool === 'python') return { code: 0, stdout: SPANS, stderr: '' };
      if (tool === 'ruff') return answers.ruff ?? { code: 1, stdout: ruffJson(root), stderr: '' };
      if (answers.complexipyWrites ?? true) {
        await writeFile(args[args.indexOf('--output') + 1] ?? '', complexipySarif(root));
      }
      return { code: 1, stdout: '', stderr: 'complexipy found functions over the limit' };
    },
    tools: { path: (name) => Promise.resolve(`/tools/${name}`), version: () => '1.0.0' },
    scratch,
    log: silentLogger,
    os: 'linux',
    facts: repoFacts(Object.keys(files), config.exclude),
    config,
    side: 'alone',
    tiers: ['commit', 'head'],
    memo: (_key, compute) => compute(),
    component: { lang: 'py', root: 'py', os: ['linux'] },
  };
  return { findings: await lint(ctx), calls, root, scratch };
}

describe('py/lint', () => {
  it('reports ruff, complexipy and the size limits, each placed in the repository', async () => {
    const { findings, calls, root, scratch } = await judge(FILES);
    expect(findings).toEqual([
      {
        rule: 'ruff/C901',
        message: '`classify` is too complex (14 > 12).',
        location: { file: 'py/src/demo/calc.py', line: 3, endLine: 72, column: 5 },
        docs: 'https://docs.astral.sh/ruff/rules/complex-structure',
      },
      {
        rule: 'ruff/F401',
        message: '`os` imported but unused.',
        location: { file: 'py/src/demo/types.pyi', line: 1, endLine: 1, column: 8 },
      },
      {
        rule: 'complexipy/CC001',
        message: "Function 'classify' has a cognitive complexity of 21; the most allowed is 15.",
        location: { file: 'py/src/demo/calc.py', line: 3, endLine: 72 },
      },
      {
        rule: 'talos/max-lines-per-function',
        message: "Function 'classify' has 70 lines of code; the most allowed is 60.",
        location: { file: 'py/src/demo/calc.py', line: 3, endLine: 72 },
      },
    ]);
    const complexipy = calls.find((c) => c.tool === 'complexipy');
    expect(complexipy?.cwd).toBe(scratch);
    expect(complexipy?.args.filter((a) => a.endsWith('.py') || a.endsWith('.pyi'))).toEqual([
      join(root, 'py', 'src/demo/__init__.py'),
      join(root, 'py', 'src/demo/calc.py'),
      join(root, 'py', 'tests/test_calc.py'),
    ]);
    const ruff = calls.find((c) => c.tool === 'ruff');
    expect(ruff?.args.slice(-4)).toEqual([
      'src/demo/__init__.py',
      'src/demo/calc.py',
      'src/demo/types.pyi',
      'tests/test_calc.py',
    ]);
  });

  it('runs only ruff over a component of stubs', async () => {
    const ruff = { code: 0, stdout: '[]', stderr: '' };
    const { findings, calls } = await judge({ 'py/src/demo/types.pyi': 'import os\n' }, { ruff });
    expect(findings).toEqual([]);
    expect(calls.map((c) => c.tool)).toEqual(['ruff']);
  });

  it("is an engine error when ruff or complexipy can't report, or there is no Python", async () => {
    const crashed = { code: 2, stdout: 'error: invalid config', stderr: '' };
    await expect(judge(FILES, { ruff: crashed })).rejects.toThrow('ruff check exited 2');
    await expect(judge(FILES, { complexipyWrites: false })).rejects.toThrow('complexipy exited 1');
    await expect(judge({ 'py/README.md': '' })).rejects.toThrow(EngineError);
  });
});
