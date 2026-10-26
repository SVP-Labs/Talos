import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Io } from './io.js';
import { verdict } from './verdict.js';
import type { Reported } from '../core/finding.js';
import type { Outcome, RunResult } from '../core/result.js';
import { exec } from '../exec/exec.js';
import { git } from '../repo/git.js';

const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

type Gate = {
  readonly cwd: string;
  readonly base: string;
  readonly head: string;
  readonly out: string;
};

/** A clone with one commit on top of its base, and a directory for the gate's files. */
async function gate(subject: string): Promise<Gate> {
  const cwd = await mkdtemp(join(tmpdir(), 'talos-verdict-'));
  const repo = git(exec, cwd);
  const commit = async (path: string, message: string): Promise<string> => {
    await writeFile(join(cwd, path), 'x\n');
    await repo.run(['add', '-A']);
    await repo.run([...COMMIT, 'commit', '-q', '-m', message]);
    return (await repo.run(['rev-parse', 'HEAD'])).trim();
  };
  await repo.run(['init', '-q']);
  await writeFile(join(cwd, 'talos.yml'), 'name: A\nprefix: A\n');
  const base = await commit('base.txt', '[A-1]: Start');
  const head = await commit('head.txt', subject);
  const out = await mkdtemp(join(tmpdir(), 'talos-verdict-out-'));
  await mkdir(join(out, 'results', 'linux'), { recursive: true });
  return { cwd, base, head, out };
}

function finding(fingerprint: string): Reported {
  return {
    rule: 'eslint/complexity',
    message: `complex ${fingerprint}`,
    location: { file: 'src/a.ts', line: 2 },
    check: 'ts/lint',
    fingerprint,
    policy: 'standard',
  };
}

async function writeResult(
  g: Gate,
  sha: string,
  findings: readonly Reported[],
  status: Outcome['status'] = 'findings',
): Promise<void> {
  const result: RunResult = {
    talos: '0.0.0',
    sha,
    tiers: ['commit', 'head'],
    os: 'linux',
    outcomes: [
      {
        check: 'ts/lint',
        tier: 'head',
        status,
        durationMs: 1,
        findings,
        ...(status === 'error' ? { reason: 'eslint crashed' } : {}),
      },
    ],
  };
  await writeFile(join(g.out, 'results', 'linux', `${sha}.json`), JSON.stringify(result));
}

async function writePlan(g: Gate): Promise<void> {
  const plan = {
    mode: 'draft',
    base: g.base,
    head: g.head,
    commits: [g.head],
    branch: 'A-1',
    runs: [],
  };
  await writeFile(join(g.out, 'plan.json'), JSON.stringify(plan));
}

function ioAt(
  cwd: string,
  env: Record<string, string>,
): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { cwd, env, out: (t) => stdout.push(t), err: (t) => stderr.push(t), stdout, stderr };
}

function args(g: Gate): string[] {
  return [
    '--plan',
    join(g.out, 'plan.json'),
    '--results',
    join(g.out, 'results'),
    '--sarif',
    join(g.out, 'talos.sarif'),
    '--json',
    join(g.out, 'verdict.json'),
  ];
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('talos verdict', () => {
  it('blocks what head adds, and writes the SARIF, the verdict, the annotations and the summary', async () => {
    const g = await gate('[A-1]: Add head');
    await writePlan(g);
    await writeResult(g, g.base, [finding('old')]);
    await writeResult(g, g.head, [finding('old'), finding('new')]);
    const summary = join(g.out, 'summary.md');
    const output = join(g.out, 'output.txt');
    const io = ioAt(g.cwd, {
      GITHUB_REF: 'refs/pull/42/merge',
      GITHUB_REPOSITORY: 'SVP-Labs/demo',
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: output,
    });
    expect(await verdict(args(g), io)).toBe(1);
    expect(await readJson(join(g.out, 'verdict.json'))).toMatchObject({
      schema: 'talos.verdict/1',
      repo: 'SVP-Labs/demo',
      pr: 42,
      mode: 'draft',
      base: g.base,
      head: g.head,
      status: 'red',
      counts: { blocking: 1, existing: 1, faults: 0 },
    });
    expect(await readJson(join(g.out, 'talos.sarif'))).toMatchObject({
      runs: [{ results: [{ properties: { why: 'existing' } }, { properties: { why: 'new' } }] }],
    });
    expect(io.stdout.join('')).toBe(
      '::error file=src/a.ts,line=2,title=eslint/complexity::complex new\n',
    );
    expect(io.stderr.join('')).toContain('1 blocking finding(s), 1 existing or informational');
    expect(await readFile(summary, 'utf8')).toContain('## Talos: red');
    expect(await readFile(output, 'utf8')).toBe('engine_error=false\n');
  });

  it('is green with no repository or PR named when the change adds nothing', async () => {
    const g = await gate('[A-1]: Add head');
    await writePlan(g);
    await writeResult(g, g.head, [], 'passed');
    const io = ioAt(g.cwd, {});
    expect(await verdict(args(g), io)).toBe(0);
    expect(await readJson(join(g.out, 'verdict.json'))).toMatchObject({
      repo: null,
      pr: null,
      status: 'green',
    });
    expect(io.stdout.join('')).toBe('');
  });

  it("blocks a commit subject that breaks the format, with no run's finding behind it", async () => {
    const g = await gate('add head');
    await writePlan(g);
    await writeResult(g, g.head, [], 'passed');
    expect(await verdict(args(g), ioAt(g.cwd, { GITHUB_REF: 'refs/heads/A-1' }))).toBe(1);
    const compact = await readJson(join(g.out, 'verdict.json'));
    expect(compact).toHaveProperty('pr', null);
    expect(compact).toHaveProperty('counts.byRule', { 'commit/subject': 1 });
  });

  it('exits 2 and says so in the step output when a check could not judge', async () => {
    const g = await gate('[A-1]: Add head');
    await writePlan(g);
    await writeResult(g, g.head, [], 'error');
    const output = join(g.out, 'output.txt');
    expect(await verdict(args(g), ioAt(g.cwd, { GITHUB_OUTPUT: output }))).toBe(2);
    expect(await readFile(output, 'utf8')).toBe('engine_error=true\n');
  });
});
