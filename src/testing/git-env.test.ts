import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedGitEnv, within } from './git-env.js';
import { clone, sh } from '../adopt/test/git.js';
import { exec } from '../exec/exec.js';

/** The variables with which git acts on a repository other than the one it would find. */
const REPOSITORY_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
];

describe("the tests' git", () => {
  it('runs with no variable that points it at another repository', () => {
    for (const name of REPOSITORY_VARIABLES) expect(process.env[name], name).toBeUndefined();
  });

  it('never looks for a repository above the temporary directory or inside the checkout', async () => {
    const ceilings = (process.env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter);
    expect(ceilings).toEqual(expect.arrayContaining([tmpdir(), process.cwd()]));
    const bare = await mkdtemp(join(tmpdir(), 'talos-git-env-'));
    expect((await exec('git', ['rev-parse', '--git-dir'], { cwd: bare })).code).not.toBe(0);
    const inside = join(process.cwd(), 'src', 'testing');
    expect((await exec('git', ['rev-parse', '--git-dir'], { cwd: inside })).code).not.toBe(0);
  });

  it("reads none of the machine's config and reaches no remote but a local path", async () => {
    const root = await mkdtemp(join(tmpdir(), 'talos-git-env-'));
    sh(root, 'init', '--quiet');
    const scopes = sh(root, 'config', '--list', '--show-scope')
      .trim()
      .split('\n')
      .map((line) => line.split('\t')[0]);
    expect(new Set(scopes)).toEqual(new Set(['local', 'command']));
    const remote = await exec('git', ['ls-remote', 'https://github.com/SVP-Labs/Talos.git'], {
      cwd: root,
    });
    expect(remote.code).not.toBe(0);
    expect(remote.stderr).toContain("transport 'https' not allowed");
  });

  it('gives a fixture clone a bare origin of its own, outside the checkout', async () => {
    const { root, origin } = await clone();
    for (const path of [root, origin]) {
      expect(within(tmpdir(), path), path).toBe(true);
      expect(within(process.cwd(), path), path).toBe(false);
    }
    expect(sh(root, 'remote', 'get-url', 'origin').trim()).toBe(origin);
  });
});

describe('isolatedGitEnv', () => {
  it("drops git's variables, keeps the rest, and turns off prompts and other transports", () => {
    const env = isolatedGitEnv(
      { PATH: '/bin', GIT_DIR: '/real/.git', git_work_tree: '/real', GIT_AUTHOR_NAME: 'A' },
      { config: '/empty', ceilings: ['/tmp', '/work'] },
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      GIT_CONFIG_GLOBAL: '/empty',
      GIT_CONFIG_SYSTEM: '/empty',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: `/tmp${delimiter}/work`,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_KEY_1: 'protocol.allow',
      GIT_CONFIG_VALUE_1: 'never',
    });
    expect(
      Object.keys(env).filter((name) => /^git_(dir|work_tree|author_name)$/i.test(name)),
    ).toEqual([]);
  });

  it('tells a path inside a directory from one beside it', () => {
    expect(within('/a/b', '/a/b')).toBe(true);
    expect(within('/a/b', '/a/b/c')).toBe(true);
    expect(within('/a/b', '/a/bc')).toBe(false);
    expect(within('/a/b', '/a')).toBe(false);
  });
});
