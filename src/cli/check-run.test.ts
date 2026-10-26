import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from './check.js';
import type { Io } from './io.js';
import { currentOs } from './run.js';
import { exec } from '../exec/exec.js';
import { type Git, git } from '../repo/git.js';

const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

const GLOSSARY = '# Glossary\n\n**Note**\nOne dated page of text.\nAvoid: memo\n';

type Clone = { readonly repo: Git; readonly base: string };

/** A clone whose base branch is clean and whose head commit says a word the glossary avoids. */
async function clone(baseBranch: string): Promise<Clone> {
  const cwd = await mkdtemp(join(tmpdir(), 'talos-check-'));
  const repo = git(exec, cwd);
  const commit = async (
    files: Readonly<Record<string, string>>,
    subject: string,
  ): Promise<string> => {
    for (const [path, content] of Object.entries(files)) await writeFile(join(cwd, path), content);
    await repo.run(['add', '-A']);
    await repo.run([...COMMIT, 'commit', '-q', '-m', subject]);
    return (await repo.run(['rev-parse', 'HEAD'])).trim();
  };
  await repo.run(['init', '-q']);
  await repo.run(['checkout', '-q', '-b', baseBranch]);
  await repo.run(['config', 'core.autocrlf', 'false']);
  const base = await commit(
    {
      'talos.yml': 'name: Notes\nprefix: NO\ndocs: { glossary: GLOSSARY.md }\n',
      'GLOSSARY.md': GLOSSARY,
      'README.md': '# Notes\n\nEach note is a page.\n',
    },
    '[NO-1]: Start the notes',
  );
  await repo.run(['checkout', '-q', '-b', 'NO-2']);
  await commit({ 'README.md': '# Notes\n\nEach memo is a page.\n' }, 'change the readme');
  return { repo, base };
}

function ioAt(cwd: string): Io & { text: () => string } {
  const out: string[] = [];
  return { cwd, env: {}, out: (t) => out.push(t), err: () => undefined, text: () => out.join('') };
}

/** Repository-wide checks run on Linux only; the commits are judged on every OS. */
const RUNS_HERE = currentOs() === 'linux';

describe('talos check, run', () => {
  it("judges the working tree against the base branch and prints the agent's verdict", async () => {
    const { repo, base } = await clone('main');
    const io = ioAt(repo.root);
    expect(await check(['--json', '--only', 'docs/glossary'], io)).toBe(1);
    const verdict: unknown = JSON.parse(io.text());
    expect(verdict).toMatchObject({ base, mode: 'draft', schema: 'talos.verdict/1' });
    expect(verdict).toHaveProperty('counts.byRule', {
      ...(RUNS_HERE ? { 'glossary/avoid': 1 } : {}),
      'commit/subject': 1,
    });
    const sarif: unknown = JSON.parse(
      await readFile(join(repo.root, '.talos/check/talos.sarif'), 'utf8'),
    );
    expect(sarif).toHaveProperty('version', '2.1.0');
  });

  it('judges every commit with --commits, and keeps the base commit’s results for the next run', async () => {
    const { repo, base } = await clone('trunk');
    const first = ioAt(repo.root);
    const args = ['--commits', '--base', 'trunk', '--only', 'docs/glossary'];
    expect(await check(args, first)).toBe(1);
    expect(first.text()).toContain('commit/subject');
    expect(first.text()).toContain(RUNS_HERE ? '2 blocking finding(s)' : '1 blocking finding(s)');
    if (RUNS_HERE) {
      const cached = await readdir(join(repo.root, '.talos', 'cache'));
      expect(cached.filter((name) => name.startsWith(base))).toHaveLength(1);
    }
    const second = ioAt(repo.root);
    expect(await check(args, second)).toBe(1);
    expect(second.text()).toBe(first.text());
    const status = await repo.run(['status', '--porcelain', '--untracked-files=all']);
    expect(await readdir(join(repo.root, '.talos'))).toContain('check');
    expect(status).not.toContain('.talos');
  });

  it('runs nothing for a tier the plan has no run of, and asks for a base it cannot find', async () => {
    const { repo } = await clone('main');
    const io = ioAt(repo.root);
    expect(await check(['--tiers', 'commit', '--only', 'docs/glossary'], io)).toBe(1);
    expect(io.text()).not.toContain('glossary/avoid');
    await repo.run(['branch', '-q', '-m', 'main', 'old']);
    await expect(check([], ioAt(repo.root))).rejects.toThrow(
      'no base to compare with: pass --base <ref>',
    );
  });
});
