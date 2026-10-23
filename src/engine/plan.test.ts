import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gatePlanSchema, planFromEvent, planRange } from './plan.js';
import { parseConfig } from '../config/load.js';
import { exec } from '../exec/exec.js';
import { type Git, git } from '../repo/git.js';

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

type Files = Readonly<Record<string, string | null>>;

/** A scratch repository whose commits each write some files and delete others. */
async function scratch(): Promise<{ repo: Git; commit: (files: Files) => Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), 'talos-plan-'));
  const repo = git(exec, root);
  await repo.run(['init', '-q']);
  const commit = async (files: Files): Promise<string> => {
    for (const [path, content] of Object.entries(files)) {
      const file = join(root, path);
      if (content === null) {
        await rm(file);
      } else {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
      }
    }
    await repo.run(['add', '-A']);
    await repo.run([...COMMIT, '--allow-empty', '-m', 'c']);
    return (await repo.run(['rev-parse', 'HEAD'])).trim();
  };
  return { repo, commit };
}

const talos = (...components: string[]): string =>
  ['name: A', 'prefix: A', 'components:', ...components.map((c) => `  - ${c}`), ''].join('\n');

const TS = '{ lang: ts, root: . }';
const API = '{ lang: php, root: ./api/, os: [windows, linux] }';
const SHOP = '{ lang: php, root: shop }';

const composer = (manifest: object): string => JSON.stringify(manifest);

describe('planRange', () => {
  it("gives every run the languages and the PHP its own commit's talos.yml asks for", async () => {
    const { repo, commit } = await scratch();
    const base = await commit({ 'talos.yml': talos(TS) });
    const middle = await commit({
      'talos.yml': talos(TS, API, SHOP),
      'api/composer.json': composer({ require: { php: '>=8.1' } }),
      'shop/composer.json': composer({
        config: { platform: { php: '8.5.2' } },
        require: { php: '^8.4' },
      }),
    });
    const head = await commit({ 'api/composer.json': composer({ require: { php: '^8.10' } }) });
    const plan = await planRange(repo, parseConfig(talos(TS, API, SHOP)), {
      mode: 'ready',
      tipOfBase: base,
      head,
    });
    const both = ['commit', 'head'];
    expect(plan).toMatchObject({ mode: 'ready', base, head, commits: [middle, head] });
    expect(plan.runs).toEqual([
      { sha: base, tiers: both, os: 'linux', langs: ['ts'], php: '' },
      { sha: middle, tiers: ['commit'], os: 'linux', langs: ['ts', 'php'], php: '8.5' },
      { sha: head, tiers: both, os: 'linux', langs: ['ts', 'php'], php: '8.10' },
      { sha: base, tiers: both, os: 'windows', langs: [], php: '' },
      { sha: middle, tiers: ['commit'], os: 'windows', langs: ['php'], php: '8.4' },
      { sha: head, tiers: both, os: 'windows', langs: ['php'], php: '8.10' },
    ]);
    expect(gatePlanSchema.parse(structuredClone(plan))).toEqual(plan);
  });

  it('plans a draft as its base and head only, on the OSes of the given config', async () => {
    const { repo, commit } = await scratch();
    const base = await commit({ 'talos.yml': talos(TS) });
    await commit({ 'talos.yml': talos(TS, API) });
    const head = await commit({ 'talos.yml': talos(TS) });
    const plan = await planRange(repo, parseConfig(talos(TS)), {
      mode: 'draft',
      tipOfBase: base,
      head,
      branch: 'TL-7',
    });
    expect(plan).toMatchObject({ mode: 'draft', commits: [], branch: 'TL-7' });
    expect(plan.runs.map((r) => [r.sha, r.os, r.langs, r.php])).toEqual([
      [base, 'linux', ['ts'], ''],
      [head, 'linux', ['ts'], ''],
    ]);
  });

  it("judges a commit with no talos.yml by the head's, and sets nothing up for a broken one", async () => {
    const { repo, commit } = await scratch();
    const base = await commit({ 'README.md': '# A\n' });
    const broken = await commit({ 'talos.yml': 'name: [\n' });
    const unknown = await commit({ 'talos.yml': `${talos(TS)}colour: blue\n` });
    const head = await commit({ 'talos.yml': talos(SHOP) });
    const plan = await planRange(repo, parseConfig(talos(SHOP)), {
      mode: 'merge-group',
      tipOfBase: base,
      head,
    });
    expect(plan.runs.map((r) => [r.sha, r.langs, r.php])).toEqual([
      [base, ['php'], '8.4'],
      [broken, [], ''],
      [unknown, [], ''],
      [head, ['php'], '8.4'],
    ]);
  });

  it('reads the PHP from composer.json as Composer does, never older than 8.4', async () => {
    const { repo, commit } = await scratch();
    const asked = async (manifest: string | null): Promise<string | undefined> => {
      const sha = await commit({ 'talos.yml': talos(SHOP), 'shop/composer.json': manifest });
      const plan = await planRange(repo, parseConfig(talos(SHOP)), {
        mode: 'draft',
        tipOfBase: sha,
        head: sha,
      });
      return plan.runs.at(-1)?.php;
    };
    const hidden = { config: { platform: { php: false } }, require: { php: '~8.6.0' } };
    expect(await asked(composer(hidden))).toBe('8.6');
    expect(await asked(composer({ require: { php: '^7.4 || ^8.0' } }))).toBe('8.4');
    expect(await asked(composer({ require: { php: '*' } }))).toBe('8.4');
    expect(await asked('{ not json')).toBe('8.4');
    expect(await asked(null)).toBe('8.4');
  });
});

describe('planFromEvent', () => {
  it('plans pull requests and the merge queue, and nothing else', async () => {
    const { repo, commit } = await scratch();
    const base = await commit({ 'talos.yml': talos(TS) });
    const head = await commit({ 'src/a.ts': 'export {};\n' });
    const config = parseConfig(talos(TS));
    const pr = (draft: boolean) => ({
      pull_request: { draft, base: { sha: base }, head: { sha: head, ref: 'TL-3' } },
    });
    expect(await planFromEvent('pull_request', pr(true), repo, config)).toMatchObject({
      mode: 'draft',
      branch: 'TL-3',
      commits: [],
    });
    expect(await planFromEvent('pull_request_target', pr(false), repo, config)).toMatchObject({
      mode: 'ready',
      commits: [head],
    });
    const queued = await planFromEvent(
      'merge_group',
      { merge_group: { base_sha: base, head_sha: head, head_ref: 'gh-readonly-queue/main/x' } },
      repo,
      config,
    );
    expect(queued).toMatchObject({ mode: 'merge-group', base, head });
    expect(queued).not.toHaveProperty('branch');
    await expect(planFromEvent('push', {}, repo, config)).rejects.toThrow(
      'the gate runs on pull_request and merge_group, not push',
    );
  });
});
