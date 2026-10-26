import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Io, UsageError } from './io.js';
import { plan } from './plan.js';
import { gatePlanSchema } from '../engine/plan.js';
import { exec } from '../exec/exec.js';
import { git } from '../repo/git.js';

const CONFIG = [
  'name: A',
  'prefix: A',
  'components:',
  '  - { lang: ts, root: ., os: [linux, macos] }',
  '  - { lang: php, root: ., os: [linux] }',
  '',
].join('\n');

/** `git commit` as a throwaway identity, unsigned, whatever the machine's git config says. */
const COMMIT = [
  '-c',
  'user.name=t',
  '-c',
  'user.email=t@t',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-q',
];

async function checkout(): Promise<{ cwd: string; base: string; head: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'talos-plan-cli-'));
  const repo = git(exec, cwd);
  const commit = async (path: string, content: string): Promise<string> => {
    await writeFile(join(cwd, path), content);
    await repo.run(['add', '-A']);
    await repo.run([...COMMIT, '-m', path]);
    return (await repo.run(['rev-parse', 'HEAD'])).trim();
  };
  await repo.run(['init', '-q']);
  const base = await commit('talos.yml', 'name: A\nprefix: A\n');
  await commit('talos.yml', CONFIG);
  const head = await commit('composer.json', JSON.stringify({ require: { php: '^8.5' } }));
  return { cwd, base, head };
}

function ioAt(cwd: string, env: Record<string, string>): Io & { output: string[] } {
  const output: string[] = [];
  return { cwd, env, out: (text) => output.push(text), err: (text) => output.push(text), output };
}

describe('talos plan', () => {
  it("writes the plan, and a matrix with each run's PHP and languages", async () => {
    const { cwd, base, head } = await checkout();
    const event = join(cwd, '..', `${head}.json`);
    await writeFile(
      event,
      JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head, ref: 'TL-1' } } }),
    );
    const githubOutput = join(cwd, '..', `${head}.out`);
    const io = ioAt(cwd, {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: githubOutput,
    });
    expect(await plan(['--out', 'plan.json'], io)).toBe(0);
    expect(io.output).toEqual(['ready: 2 commit(s), 6 run(s)\n']);
    const written = gatePlanSchema.parse(
      JSON.parse(await readFile(join(cwd, 'plan.json'), 'utf8')),
    );
    expect(written).toMatchObject({ mode: 'ready', base, head, branch: 'TL-1' });
    const line = await readFile(githubOutput, 'utf8');
    expect(line.startsWith('matrix=')).toBe(true);
    const matrix: unknown = JSON.parse(line.slice('matrix='.length));
    const linux = { os: 'linux', runner: 'ubuntu-latest' };
    const macos = { os: 'macos', runner: 'macos-latest' };
    expect(matrix).toEqual({
      include: [
        { sha: base, tiers: 'commit,head', ...linux, langs: '', php: '' },
        { sha: written.commits[0], tiers: 'commit', ...linux, langs: 'ts,php', php: '8.4' },
        { sha: head, tiers: 'commit,head', ...linux, langs: 'ts,php', php: '8.5' },
        { sha: base, tiers: 'commit,head', ...macos, langs: '', php: '' },
        { sha: written.commits[0], tiers: 'commit', ...macos, langs: 'ts', php: '' },
        { sha: head, tiers: 'commit,head', ...macos, langs: 'ts', php: '' },
      ],
    });
  });

  it('needs the event', async () => {
    const { cwd } = await checkout();
    await expect(plan([], ioAt(cwd, { GITHUB_EVENT_NAME: 'pull_request' }))).rejects.toThrow(
      new UsageError('--event is required'),
    );
  });
});
