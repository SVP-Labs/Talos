import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mutantsRunner } from './mutants.js';
import { parseConfig } from '../../config/load.js';
import { type CheckContext, EngineError } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { ExecOptions } from '../../exec/exec.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

type Call = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ExecOptions;
};

type Mutants = { readonly code: number; readonly writes: boolean };

async function context(mutants: Mutants): Promise<{ ctx: CheckContext; calls: Call[] }> {
  const files = {
    'rs/Cargo.toml': '[package]\nname = "demo"\n',
    'rs/src/lib.rs': 'pub fn f() {}\n',
  };
  const root = await tempRepo(files);
  const calls: Call[] = [];
  const config = parseConfig(MINIMAL_CONFIG);
  const ctx: CheckContext = {
    root,
    sha: '0'.repeat(40),
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === 'metadata') {
        const metadata = { workspace_root: join(root, 'rs'), packages: [] };
        return { code: 0, stdout: JSON.stringify(metadata), stderr: '' };
      }
      const output = args[args.indexOf('--output') + 1] ?? '';
      if (mutants.writes) {
        await mkdir(join(output, 'mutants.out'), { recursive: true });
        await writeFile(
          join(output, 'mutants.out', 'outcomes.json'),
          '{"outcomes":[{"summary":"MissedMutant"}]}',
        );
      }
      return { code: mutants.code, stdout: '', stderr: 'cargo-mutants failed to copy the tree' };
    },
    tools: {
      path: (name) => Promise.resolve(`/tools/${name}/bin/${name}`),
      version: () => '1.0.0',
    },
    scratch: await mkdtemp(join(tmpdir(), 'talos-mutants-')),
    log: silentLogger,
    os: 'linux',
    facts: repoFacts(Object.keys(files), config.exclude),
    config,
    side: 'alone',
    tiers: ['commit', 'head'],
    memo: (_key, compute) => compute(),
    component: { lang: 'rust', root: 'rs', os: ['linux'] },
  };
  return { ctx, calls };
}

describe('mutantsRunner', () => {
  it("mutates the component's Rust files, with nextest on PATH, and reads its outcomes", async () => {
    const { ctx, calls } = await context({ code: 2, writes: true });
    const report = await mutantsRunner.run(ctx, [
      'rs/src/lib.rs',
      'rs/README.md',
      'other/src/x.rs',
    ]);
    expect(report.format).toBe('cargo-mutants');
    expect(report.base).toBe(join(ctx.root, 'rs'));
    expect(await readFile(report.path, 'utf8')).toContain('MissedMutant');
    const run = calls.find((c) => c.command === '/tools/cargo-mutants/bin/cargo-mutants');
    expect(run?.args[0]).toBe('mutants');
    expect(run?.args.slice(-2)).toEqual(['--file', 'src/lib.rs']);
    expect(run?.options.cwd).toBe(join(ctx.root, 'rs'));
    expect(Object.values(run?.options.env ?? {}).join(':')).toContain('/tools/cargo-nextest/bin');
  });

  it('reports no mutants without running anything when no Rust file is asked for', async () => {
    const { ctx, calls } = await context({ code: 0, writes: false });
    const report = await mutantsRunner.run(ctx, ['rs/Cargo.toml']);
    expect(JSON.parse(await readFile(report.path, 'utf8'))).toEqual({
      outcomes: [],
      total_mutants: 0,
    });
    expect(calls.map((c) => c.args[0])).toEqual(['metadata']);
  });

  it("is an engine error when cargo-mutants couldn't judge its mutants", async () => {
    const crashed = await context({ code: 1, writes: true });
    await expect(mutantsRunner.run(crashed.ctx, ['rs/src/lib.rs'])).rejects.toThrow(
      'cargo mutants exited 1',
    );
    const silent = await context({ code: 0, writes: false });
    await expect(mutantsRunner.run(silent.ctx, ['rs/src/lib.rs'])).rejects.toThrow(
      new EngineError('cargo-mutants wrote no outcomes.json (exit 0)'),
    );
  });
});
