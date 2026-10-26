import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextestRunner } from './nextest.js';
import { parseConfig } from '../../config/load.js';
import { type CheckContext, EngineError } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { Exec, ExecResult } from '../../exec/exec.js';
import type { TestRequest } from '../../quality/protocol.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

const FILES = {
  'Cargo.toml': '[package]\nname = "demo"\n',
  'src/lib.rs': 'pub mod a;\n\n/// ```\n/// demo::add();\n/// ```\npub fn add() {}\n',
  'src/a.rs': [
    'pub fn one() -> u8 {',
    '    1',
    '}',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    #[test]',
    '    fn works() {',
    '        assert_eq!(super::one(), 1);',
    '    }',
    '}',
    '',
  ].join('\n'),
  'tests/slow.rs': '#[test]\nfn it_works() {}\n',
};

function metadata(root: string): string {
  return JSON.stringify({
    workspace_root: root,
    packages: [
      {
        name: 'demo',
        manifest_path: join(root, 'Cargo.toml'),
        targets: [
          { kind: ['lib'], name: 'demo', src_path: join(root, 'src/lib.rs'), doctest: true },
          { kind: ['test'], name: 'slow', src_path: join(root, 'tests/slow.rs'), doctest: false },
        ],
      },
    ],
  });
}

const JUNIT = [
  '<testsuites><testsuite name="demo">',
  '<testcase name="a::tests::works" classname="demo"/>',
  '<testcase name="it_works" classname="demo::slow"><failure message="boom"/></testcase>',
  '</testsuite></testsuites>',
].join('');

type Call = { readonly command: string; readonly args: readonly string[] };

type Cargo = {
  /** What `cargo test --doc` answers. */
  readonly doc?: ExecResult;
  /** nextest's exit code, and whether it wrote its JUnit. */
  readonly code?: number;
  readonly junit?: boolean;
  readonly stderr?: string;
};

/** The LCOV cargo-llvm-cov writes: the crate's code, a test file and a dependency elsewhere. */
function lcovOf(root: string): string {
  return [
    `SF:${join(root, 'src/a.rs')}`,
    'DA:1,1',
    'DA:2,1',
    'DA:9,1',
    'end_of_record',
    `SF:${join(root, 'tests/slow.rs')}`,
    'DA:2,1',
    'end_of_record',
    'SF:/elsewhere/dep.rs',
    'DA:1,1',
    'end_of_record',
    '',
  ].join('\n');
}

/** What a nextest run, under cargo-llvm-cov or not, leaves behind and answers. */
async function nextestRun(
  root: string,
  cargo: Cargo,
  args: readonly string[],
): Promise<ExecResult> {
  const config = args[args.indexOf('--tool-config-file') + 1]?.slice('talos:'.length) ?? '';
  const store = join(dirname(config), 'store', 'talos');
  if (cargo.junit ?? true) {
    await mkdir(store, { recursive: true });
    await writeFile(join(store, 'junit.xml'), JUNIT);
  }
  const output = args.indexOf('--output-path');
  if (output >= 0) await writeFile(args[output + 1] ?? '', lcovOf(root));
  return { code: cargo.code ?? 100, stdout: 'nextest ran\n', stderr: cargo.stderr ?? '' };
}

const DOCTESTS_PASS: ExecResult = {
  code: 0,
  stdout: 'test src/lib.rs - add (line 3) ... ok\n',
  stderr: '',
};

/** cargo, cargo-nextest and cargo-llvm-cov as they answer for the demo workspace. */
function fakeCargo(root: string, cargo: Cargo, calls: Call[]): Exec {
  return async (command, args) => {
    calls.push({ command, args });
    if (command !== 'cargo') return nextestRun(root, cargo, args);
    if (args[0] === 'metadata') return { code: 0, stdout: metadata(root), stderr: '' };
    return cargo.doc ?? DOCTESTS_PASS;
  };
}

async function context(
  cargo: Cargo,
  yml = MINIMAL_CONFIG,
): Promise<{ ctx: CheckContext; calls: Call[] }> {
  const root = await tempRepo(FILES);
  const calls: Call[] = [];
  const config = parseConfig(yml);
  const ctx: CheckContext = {
    root,
    sha: '0'.repeat(40),
    exec: fakeCargo(root, cargo, calls),
    tools: { path: (name) => Promise.resolve(`/tools/${name}`), version: () => '1.0.0' },
    scratch: await mkdtemp(join(tmpdir(), 'talos-nextest-')),
    log: silentLogger,
    os: 'linux',
    facts: repoFacts(Object.keys(FILES), config.exclude),
    config,
    side: 'alone',
    tiers: ['commit', 'head'],
    memo: (_key, compute) => compute(),
    component: { lang: 'rust', root: '.', os: ['linux'] },
  };
  return { ctx, calls };
}

const ALL: TestRequest = { suite: 'all', coverage: false };

describe('nextestRunner', () => {
  it('runs every test, placing each case in its file, and the doctests beside them', async () => {
    const { ctx, calls } = await context({});
    const run = await nextestRunner.run(ctx, ALL);
    expect(run.exitCode).toBe(100);
    expect(run.output).toBe('nextest ran\ntest src/lib.rs - add (line 3) ... ok\n');
    expect(run.coverage).toBeUndefined();
    const [tests, docs] = run.junit;
    expect(tests?.base).toBe(ctx.root);
    const xml = await readFile(tests?.path ?? '', 'utf8');
    expect(xml).toContain('<testcase file="src/a.rs" name="a::tests::works"');
    expect(xml).toContain('<testcase file="tests/slow.rs" name="it_works"');
    expect(await readFile(docs?.path ?? '', 'utf8')).toContain('file="src/lib.rs"');
    const nextest = calls.find((c) => c.command === '/tools/cargo-nextest');
    expect(nextest?.args.slice(0, 2)).toEqual(['nextest', 'run']);
    expect(nextest?.args).not.toContain('-E');
  });

  it('measures coverage under cargo-llvm-cov, keeping only the code it owns outside the tests', async () => {
    const { ctx, calls } = await context({});
    const run = await nextestRunner.run(ctx, { suite: 'all', coverage: true });
    expect(
      calls.some((c) => c.command === '/tools/cargo-llvm-cov' && c.args[1] === 'nextest'),
    ).toBe(true);
    expect(run.coverage?.format).toBe('lcov');
    const lcov = await readFile(run.coverage?.path ?? '', 'utf8');
    expect(lcov).toContain('SF:src/a.rs');
    expect(lcov).not.toContain('slow.rs');
    expect(lcov).not.toContain('dep.rs');
    expect(lcov).not.toContain('DA:9,');
  });

  it('leaves out tests.full on a commit, in nextest and in the doctests', async () => {
    const { ctx, calls } = await context(
      { code: 0 },
      `${MINIMAL_CONFIG}tests:\n  full: [tests/slow.rs]\n`,
    );
    const run = await nextestRunner.run(ctx, { suite: 'commit', coverage: false });
    expect(run.exitCode).toBe(0);
    const nextest = calls.find((c) => c.command === '/tools/cargo-nextest');
    expect(nextest?.args.slice(-2)).toEqual(['-E', 'not (binary_id(=demo::slow))']);
    const doc = calls.find((c) => c.command === 'cargo' && c.args[0] === 'test');
    expect(doc?.args.slice(-2)).toEqual(['--skip', 'tests/slow.rs']);
  });

  it('runs nothing for a rerun of files no test lives in', async () => {
    const { ctx, calls } = await context({});
    const run = await nextestRunner.run(ctx, { ...ALL, files: ['README.md'] });
    expect(run).toEqual({ exitCode: 0, output: '', junit: [] });
    expect(calls.map((c) => c.args[0])).toEqual(['metadata']);
  });

  it("stands tests that don't build for one failing case", async () => {
    const stderr = 'error[E0425]: cannot find value `x` in this scope\n';
    const { ctx } = await context({ code: 101, junit: false, stderr });
    const run = await nextestRunner.run(ctx, ALL);
    expect(run.exitCode).toBe(101);
    const xml = await readFile(run.junit[0]?.path ?? '', 'utf8');
    expect(xml).toContain('name="the tests build"');
    expect(xml).toContain('message="error[E0425]: cannot find value `x` in this scope"');
  });

  it('is an engine error when nextest wrote no report and the tests built', async () => {
    const { ctx } = await context({ code: 1, junit: false });
    await expect(nextestRunner.run(ctx, ALL)).rejects.toThrow(
      new EngineError('cargo-nextest wrote no JUnit report (exit 1)'),
    );
  });

  it("stands doctests that don't build for one failing case", async () => {
    const doc = { code: 101, stdout: '', stderr: 'error: doctest failed to compile\n' };
    const { ctx } = await context({ code: 0, doc });
    const run = await nextestRunner.run(ctx, ALL);
    expect(run.exitCode).toBe(101);
    const xml = await readFile(run.junit[1]?.path ?? '', 'utf8');
    expect(xml).toContain('name="the doctests build"');
    expect(xml).toContain('message="error: doctest failed to compile"');
  });
});
