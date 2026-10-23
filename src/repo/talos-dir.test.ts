import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from './git.js';
import { createTalosDir, talosPath } from './talos-dir.js';
import { exec } from '../exec/exec.js';

async function scratchRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'talos-dir-test-'));
  await git(exec, root).run(['init', '--quiet']);
  return root;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe('createTalosDir', () => {
  it('creates the folder with a .gitignore that hides all of it from git', async () => {
    const root = await scratchRepo();
    const reports = await createTalosDir(root, 'check');
    expect(reports).toBe(join(root, '.talos', 'check'));
    expect(await readFile(join(root, '.talos', '.gitignore'), 'utf8')).toBe('*\n');
    await writeFile(join(reports, 'talos.sarif'), '{}');
    await writeFile(join(await createTalosDir(root, 'cache', 'deep'), 'run.json'), '{}');
    const status = git(exec, root).run(['status', '--porcelain', '--untracked-files=all']);
    expect(await status).toBe('');
  });

  it('writes the ignore file once, and keeps one someone put there', async () => {
    const root = await scratchRepo();
    await createTalosDir(root, 'worktrees');
    expect(await createTalosDir(root, 'worktrees')).toBe(join(root, '.talos', 'worktrees'));
    expect(await readFile(join(root, '.talos', '.gitignore'), 'utf8')).toBe('*\n');
    const own = await scratchRepo();
    await mkdir(join(own, '.talos'));
    await writeFile(join(own, '.talos', '.gitignore'), 'cache/\n');
    await createTalosDir(own, 'cache');
    expect(await readFile(join(own, '.talos', '.gitignore'), 'utf8')).toBe('cache/\n');
  });

  it('fails when the folder cannot be made', async () => {
    const root = await scratchRepo();
    await writeFile(join(root, '.talos'), 'a file, not a folder\n');
    await expect(createTalosDir(root, 'check')).rejects.toThrow();
  });
});

describe('talosPath', () => {
  it('names a place in the folder without creating anything', async () => {
    const root = await scratchRepo();
    expect(talosPath(root, 'cache', 'a.json')).toBe(join(root, '.talos', 'cache', 'a.json'));
    expect(await exists(join(root, '.talos'))).toBe(false);
  });
});
