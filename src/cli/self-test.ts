import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { type Command, parse } from './io.js';
import { currentOs } from './run.js';
import { ConfigError, loadConfig } from '../config/load.js';
import type { TalosConfig } from '../config/schema.js';
import type { Os } from '../core/check.js';
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

/**
 * The operating systems `expect.json` lists beyond Linux that no component of the case's
 * `talos.yml` declares: no component check is planned there, so the case can't pass on them.
 * A `talos.yml` that can't be read lists none; the case's run reports it.
 */
export async function undeclaredOses(source: string, expected: Expectation): Promise<Os[]> {
  let config: TalosConfig;
  try {
    config = await loadConfig(source);
  } catch (error) {
    if (error instanceof ConfigError) return [];
    throw error;
  }
  return expected.os.filter(
    (os) => os !== 'linux' && !config.components.some((c) => c.os.includes(os)),
  );
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
 * Runs one case in a fresh repository: what went wrong, or nothing when it isn't for this OS. A
 * case expecting an OS its `talos.yml` declares no component on fails on every OS.
 */
async function runCase(
  engine: Engine,
  source: string,
  expected: Expectation,
  os: Os,
): Promise<string[] | undefined> {
  const undeclared = await undeclaredOses(source, expected);
  if (undeclared.length > 0) {
    return [`expect.json lists ${undeclared.join(', ')}, which no component in talos.yml runs on`];
  }
  if (!expected.os.includes(os)) return undefined;
  const directory = await freshRepo(engine, source);
  try {
    const sha = (
      await execOk(engine.exec, 'git', ['rev-parse', 'HEAD'], { cwd: directory })
    ).trim();
    const at = { root: directory, sha, os, side: 'alone' as const, only: expected.checks };
    return await runAt(engine, { ...at, tiers: ['commit', 'head'] }).then(
      (result) => assess(expected, result),
      (error: unknown) => [
        `engine error: ${error instanceof Error ? error.message : String(error)}`,
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  // The runtime cases read recorded vendor feeds, so the self-test doesn't drift with the network.
  const feeds = join(root, 'runtime', 'feeds');
  if (process.env.TALOS_RUNTIME_FEEDS === undefined && existsSync(feeds)) {
    process.env.TALOS_RUNTIME_FEEDS = feeds;
  }
  const engine = createEngine(values.verbose);
  const os = currentOs();
  let failed = 0;
  for (const source of await findCases(root)) {
    const name = relative(root, source);
    if (values.only !== undefined && !name.startsWith(values.only)) continue;
    const expected = expectation.parse(
      JSON.parse(await readFile(join(source, 'expect.json'), 'utf8')),
    );
    const problems = await runCase(engine, source, expected, os);
    if (problems === undefined) continue;
    failed += problems.length > 0 ? 1 : 0;
    const mark = problems.length > 0 ? 'FAIL' : 'ok  ';
    const detail = problems.map((p) => `     ${p}\n`).join('');
    io.out(`${mark} ${name}\n${detail}`);
  }
  io.out(failed > 0 ? `${failed} case(s) failed\n` : 'all cases passed\n');
  return failed > 0 ? 1 : 0;
};
