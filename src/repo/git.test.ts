import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, inWorktree, revParse } from './git.js';
import { exec } from '../exec/exec.js';

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'talos-git-test-'));
  const repo = git(exec, root);
  await repo.run(['init', '--quiet', '--initial-branch=main']);
  await writeFile(join(root, 'a.txt'), 'one\n');
  await repo.run(['add', '--all']);
  await repo.run([
    '-c',
    'user.name=Talos',
    '-c',
    'user.email=talos@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--message',
    '[T-1]: Seed',
  ]);
  return { root, repo, sha: await revParse(repo, 'HEAD') };
}

async function gone(path: string): Promise<boolean> {
  return access(path).then(
    () => false,
    () => true,
  );
}

describe('inWorktree', () => {
  it('works in a checkout of the commit and removes it afterwards', async () => {
    const { root, repo, sha } = await scratch();
    const directory = join(root, '.talos', 'worktrees', sha);
    const text = await inWorktree(repo, { sha, directory }, () =>
      readFile(join(directory, 'a.txt'), 'utf8'),
    );
    expect(text).toBe('one\n');
    expect(await gone(directory)).toBe(true);
    expect(await repo.run(['worktree', 'list'])).not.toContain(directory);
  });

  it('clears what an earlier run left behind, and removes its own when the work fails', async () => {
    const { root, repo, sha } = await scratch();
    const directory = join(root, '.talos', 'worktrees', sha);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'stale.txt'), 'left behind\n');
    await expect(
      inWorktree(repo, { sha, directory }, async () => {
        expect(await gone(join(directory, 'stale.txt'))).toBe(true);
        throw new Error('the run failed');
      }),
    ).rejects.toThrow('the run failed');
    expect(await gone(directory)).toBe(true);
  });
});
