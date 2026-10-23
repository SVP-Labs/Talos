import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPlan,
  checkoutClaim,
  commitPaths,
  isClean,
  pushBranch,
  readTree,
  safePath,
} from './local.js';
import type { AdoptPlan } from './plan.js';
import { parseConfig } from '../config/load.js';
import { clone, quietExec as exec, sh } from './test/git.js';

function plan(write: AdoptPlan['write'], deletions: AdoptPlan['delete'] = []): AdoptPlan {
  return {
    config: parseConfig('name: X\nprefix: X\n'),
    talosYml: 'written',
    brief: undefined,
    scaffold: false,
    write,
    delete: deletions,
    next: [],
  };
}

describe('the working tree', () => {
  it('reads tracked files and writes and deletes what a plan says', async () => {
    const { root } = await clone();
    const tree = await readTree(root, exec);
    expect(tree.files).toEqual(['package.json']);
    expect(tree.read('package.json')).toBe('{}\n');
    expect(tree.read('missing')).toBeUndefined();
    expect(await isClean(root, exec)).toBe(true);
    await applyPlan(
      root,
      plan(
        [{ path: '.github/ISSUE_TEMPLATE/a.yml', content: 'a\n', why: 'issue-form' }],
        [{ path: 'package.json', why: 'scaffold' }],
      ),
    );
    expect(await readFile(join(root, '.github/ISSUE_TEMPLATE/a.yml'), 'utf8')).toBe('a\n');
    expect(await isClean(root, exec)).toBe(false);
    expect((await readTree(root, exec)).files).toEqual([]);
  });

  it('refuses a path outside the repository', () => {
    expect(safePath('a/../b')).toBe('b');
    for (const bad of ['../x', '/etc/passwd', '..', '.', 'a/../../x']) {
      expect(() => safePath(bad)).toThrow(/outside the repository/);
    }
  });
});

describe('git', () => {
  it('checks out the claimed branch from origin, commits only the planned paths and pushes', async () => {
    const { root, origin } = await clone();
    sh(origin, 'branch', 'X-1', 'main');
    await checkoutClaim(root, exec, 'X-1');
    expect(sh(root, 'branch', '--show-current').trim()).toBe('X-1');
    await writeFile(join(root, 'talos.yml'), 'name: X\n');
    await writeFile(join(root, 'stray.txt'), 'not mine\n');
    expect(await commitPaths(root, exec, ['talos.yml'], '[X-1]: Bring X under Talos')).toBe(true);
    expect(sh(root, 'show', '--name-only', '--format=%s', 'HEAD').trim()).toBe(
      '[X-1]: Bring X under Talos\n\ntalos.yml',
    );
    expect(await commitPaths(root, exec, [], 'nothing')).toBe(false);
    await pushBranch(root, exec, 'X-1');
    expect(sh(origin, 'log', '--format=%s', '-1', 'X-1').trim()).toBe('[X-1]: Bring X under Talos');
    await checkoutClaim(root, exec, 'main');
    await checkoutClaim(root, exec, 'X-1');
    expect(sh(root, 'branch', '--show-current').trim()).toBe('X-1');
  });
});
