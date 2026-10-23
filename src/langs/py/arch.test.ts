import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arch } from './arch.js';
import type { Bound } from './run.js';
import { parseConfig } from '../../config/load.js';
import { EngineError } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { ExecResult } from '../../exec/exec.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

const SOURCES = {
  'src/layered/__init__.py': '',
  'src/layered/ring_a.py': 'from layered import ring_b\n',
  'src/layered/ring_b.py': 'from layered import ring_a\n',
  'src/layered/high/__init__.py': '',
  'src/layered/high/top.py': 'VALUE = 1\n',
  'src/layered/low/__init__.py': '',
  'src/layered/low/base.py':
    'import pytest\nfrom tests import helpers\nfrom layered.high import top\n',
  'tests/__init__.py': '',
  'tests/helpers.py': 'HELP = 1\n',
};

const PYPROJECT = [
  '[project]',
  'name = "layered"',
  '',
  '[tool.importlinter]',
  'root_packages = ["layered"]',
  '',
  '[[tool.importlinter.contracts]]',
  'name = "High sits above low"',
  'type = "layers"',
  'layers = ["layered.high", "layered.low"]',
  '',
  '[[tool.importlinter.contracts]]',
  'name = "Rings stay apart"',
  'type = "independence"',
  'modules = ["layered.ring_a", "layered.ring_b"]',
  '',
].join('\n');

/** A uv.lock in which pytest comes only with the dev group. */
const UV_LOCK = [
  'version = 1',
  '',
  '[[package]]',
  'name = "layered"',
  'version = "0.1.0"',
  'source = { editable = "." }',
  '',
  '[package.dev-dependencies]',
  'dev = [{ name = "pytest" }]',
  '',
  '[[package]]',
  'name = "pytest"',
  'version = "9.1.1"',
  'source = { registry = "https://pypi.org/simple" }',
  '',
].join('\n');

const ENVIRONMENT = JSON.stringify({
  versions: { layered: '0.1.0', pytest: '9.1.1' },
  modules: { layered: ['layered'], pytest: ['pytest'], _pytest: ['pytest'] },
});

/** `lint-imports --no-logo` output with these contracts broken. */
function report(broken: readonly (readonly [string, readonly string[]])[]): string {
  const lines = [
    `Contracts: 0 kept, ${broken.length} broken.`,
    '',
    '',
    'Broken contracts',
    '----------------',
    '',
  ];
  for (const [name, body] of broken) lines.push(name, '-'.repeat(name.length), '', ...body, '', '');
  return lines.join('\n');
}

const UNIVERSAL_BROKEN = report([
  [
    'No import cycles between the modules of a package',
    [
      'No cycles are allowed in layered.',
      'It could be made acyclic by removing 1 dependency:',
      '',
      '- .ring_b -> .ring_a (1 import)',
    ],
  ],
  [
    'Shipped code imports no test code',
    ['layered is not allowed to import tests:', '', '- layered.low.base -> tests.helpers (l.2)'],
  ],
  [
    'Shipped code imports no dev-only dependency',
    ['layered is not allowed to import pytest:', '', '- layered.gone -> pytest (l.1)'],
  ],
]);

const OWN_BROKEN = report([
  [
    'High sits above low',
    [
      'layered.low is not allowed to import layered.high:',
      '',
      '- layered.low.base -> layered.mid (l.3)',
      '  layered.mid -> layered.high.top (l.1)',
    ],
  ],
  ['Rings stay apart', []],
]);

type Answers = { readonly universal?: ExecResult; readonly own?: ExecResult };

async function run(
  files: Readonly<Record<string, string>>,
  answers: Answers = {},
): Promise<{ findings: Awaited<ReturnType<typeof arch>>; configs: string[] }> {
  const venv = { '.venv/bin/lint-imports': '', '.venv/bin/python': '' };
  const root = await tempRepo({ ...files, ...venv });
  const config = parseConfig(MINIMAL_CONFIG);
  const configs: string[] = [];
  const ctx: Bound = {
    root,
    sha: '0'.repeat(40),
    exec: async (command, args) => {
      if (command.endsWith('python')) return { code: 0, stdout: ENVIRONMENT, stderr: '' };
      const config = args[1] ?? '';
      if (config === 'pyproject.toml') {
        return answers.own ?? { code: 1, stdout: OWN_BROKEN, stderr: '' };
      }
      configs.push(await readFile(config, 'utf8'));
      return answers.universal ?? { code: 1, stdout: UNIVERSAL_BROKEN, stderr: '' };
    },
    tools: { path: (name) => Promise.resolve(`/tools/${name}`), version: () => '1.0.0' },
    scratch: await mkdtemp(join(tmpdir(), 'talos-py-arch-')),
    log: silentLogger,
    os: 'linux',
    facts: repoFacts(Object.keys(files), config.exclude),
    config,
    side: 'alone',
    tiers: ['commit', 'head'],
    memo: (_key, compute) => compute(),
    component: { lang: 'py', root: '.', os: ['linux'] },
  };
  return { findings: await arch(ctx), configs };
}

describe('py/arch', () => {
  it("checks Talos's universal contracts, then the project's own", async () => {
    const { findings, configs } = await run({
      ...SOURCES,
      'pyproject.toml': PYPROJECT,
      'uv.lock': UV_LOCK,
    });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toContain('forbidden_modules = [ "_pytest", "pytest" ]');
    expect(configs[0]).toContain('forbidden_modules = [ "tests" ]');
    expect(findings).toEqual([
      {
        rule: 'import-linter/acyclic_siblings',
        message: 'layered.ring_b imports layered.ring_a, which closes an import cycle in layered.',
        key: 'No import cycles between the modules of a package: layered.ring_b -> layered.ring_a',
      },
      {
        rule: 'import-linter/forbidden',
        message:
          'layered.low.base imports tests.helpers, which the contract "Shipped code imports no test code" forbids.',
        location: { file: 'src/layered/low/base.py', line: 2 },
      },
      {
        rule: 'import-linter/forbidden',
        message:
          'layered.gone imports pytest, which the contract "Shipped code imports no dev-only dependency" forbids.',
        key: 'Shipped code imports no dev-only dependency: layered.gone -> pytest',
      },
      {
        rule: 'import-linter/layers',
        message:
          'layered.low.base imports layered.high.top (through layered.mid), which the contract "High sits above low" forbids.',
        location: { file: 'src/layered/low/base.py', line: 3 },
      },
      {
        rule: 'import-linter/independence',
        message: 'The import-linter contract "Rings stay apart" is broken.',
        key: 'Rings stay apart',
      },
    ]);
  });

  it("forbids no dev-only module without a uv.lock, and runs no project contracts it doesn't have", async () => {
    const kept = { code: 0, stdout: 'Contracts: 2 kept, 0 broken.\n', stderr: '' };
    const { findings, configs } = await run(SOURCES, { universal: kept });
    expect(findings).toEqual([]);
    expect(configs[0]).not.toContain('pytest');
    expect(configs[0]).toContain('include_external_packages = false');
  });

  it("reports a project configuration lint-imports can't read as a finding of its own", async () => {
    const kept = { code: 0, stdout: 'Contracts: 2 kept, 0 broken.\n', stderr: '' };
    const unreadable = {
      code: 1,
      stdout: '',
      stderr: 'Traceback\nValueError: unknown contract type "layer"',
    };
    const { findings } = await run(
      { ...SOURCES, 'pyproject.toml': PYPROJECT },
      { universal: kept, own: unreadable },
    );
    expect(findings).toEqual([
      {
        rule: 'import-linter/config',
        message:
          'import-linter could not check the contracts in pyproject.toml: ValueError: unknown contract type "layer"',
        key: 'pyproject.toml',
      },
    ]);
  });

  it("is an engine error when the universal contracts can't run", async () => {
    const crashed = { code: 1, stdout: '', stderr: 'ModuleNotFoundError: No module named layered' };
    await expect(run(SOURCES, { universal: crashed })).rejects.toThrow(EngineError);
  });

  it('judges only the project contracts of a component that ships no package', async () => {
    const { findings, configs } = await run({ 'scripts/tool.py': '', 'pyproject.toml': PYPROJECT });
    expect(configs).toEqual([]);
    expect(findings.map((f) => f.rule)).toEqual([
      'import-linter/layers',
      'import-linter/independence',
    ]);
  });
});
