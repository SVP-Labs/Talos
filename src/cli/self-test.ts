import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { type Command, parse } from './io.js';
import { currentOs } from './run.js';
import type { RunResult } from '../core/result.js';
import { runAt } from '../engine/local.js';
import type { Engine } from '../engine/run.js';
import { createEngine } from '../engine/session.js';
import { execOk } from '../exec/exec.js';

const expectation = z.object({
  checks: z.array(z.string()).min(1),
  rules: z.array(z.string()).default([]),
  clean: z.boolean().default(false),
  os: z.array(z.enum(['linux', 'windows', 'macos'])).default(['linux']),
});

type Expectation = z.infer<typeof expectation>;

async function findCases(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith('expect.json') && !entry.includes('node_modules'))
    .map((entry) => join(root, entry, '..'))
    .sort((a, b) => a.localeCompare(b));
}

async function freshRepo(engine: Engine, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'talos-case-'));
  await cp(source, directory, { recursive: true, filter: (path) => !path.endsWith('expect.json') });
  const git = async (...args: string[]): Promise<void> => {
    await execOk(engine.exec, 'git', args, { cwd: directory });
  };
  await git('init', '--quiet', '--initial-branch=main');
  await git('add', '--all');
  await git(
    '-c',
    'user.name=Talos',
    '-c',
    'user.email=talos@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--message',
    '[T-1]: Seed the test project',
  );
  return directory;
}

/** What went wrong with one case, or nothing. */
export function assess(expected: Expectation, result: RunResult): string[] {
  const problems = result.outcomes
    .filter((o) => o.status === 'error')
    .map((o) => `engine error in ${o.check}: ${o.reason ?? ''}`);
  const ran = new Set(result.outcomes.filter((o) => o.status !== 'skipped').map((o) => o.check));
  for (const check of expected.checks.filter((c) => !ran.has(c))) {
    const skipped = result.outcomes.find((o) => o.check === check);
    const why = skipped?.reason === undefined ? '' : `: ${skipped.reason}`;
    problems.push(`${check} did not run${why}`);
  }
  const rules = new Set(result.outcomes.flatMap((o) => o.findings.map((f) => f.rule)));
  for (const rule of expected.rules.filter((r) => !rules.has(r))) {
    problems.push(`no ${rule} finding`);
  }
  if (expected.clean && rules.size > 0) {
    problems.push(`expected no findings, got ${[...rules].join(', ')}`);
  }
  return problems;
}

/**
 * `talos self-test <dir>`: runs each test project's checks with this engine and compares the
 * findings with the project's `expect.json`.
 */
export const selfTest: Command = async (argv, io) => {
  const { values, positionals } = parse(
    argv,
    { only: { type: 'string' }, verbose: { type: 'boolean', default: false } },
    true,
  );
  const root = resolve(io.cwd, positionals[0] ?? 'test-projects');
  const engine = createEngine(values.verbose);
  const os = currentOs();
  let failed = 0;
  for (const source of await findCases(root)) {
    const name = relative(root, source);
    if (values.only !== undefined && !name.startsWith(values.only)) continue;
    const expected = expectation.parse(
      JSON.parse(await readFile(join(source, 'expect.json'), 'utf8')),
    );
    if (!expected.os.includes(os)) continue;
    const directory = await freshRepo(engine, source);
    try {
      const sha = (
        await execOk(engine.exec, 'git', ['rev-parse', 'HEAD'], { cwd: directory })
      ).trim();
      const at = { root: directory, sha, os, side: 'alone' as const, only: expected.checks };
      const problems = await runAt(engine, { ...at, tiers: ['commit', 'head'] }).then(
        (result) => assess(expected, result),
        (error: unknown) => [
          `engine error: ${error instanceof Error ? error.message : String(error)}`,
        ],
      );
      failed += problems.length > 0 ? 1 : 0;
      const mark = problems.length > 0 ? 'FAIL' : 'ok  ';
      const detail = problems.map((p) => `     ${p}\n`).join('');
      io.out(`${mark} ${name}\n${detail}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  io.out(failed > 0 ? `${failed} case(s) failed\n` : 'all cases passed\n');
  return failed > 0 ? 1 : 0;
};
