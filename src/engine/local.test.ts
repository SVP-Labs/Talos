import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedRun, runAt } from './local.js';
import { parseConfig } from '../config/load.js';
import { APPLIES, type Check } from '../core/check.js';
import { exec } from '../exec/exec.js';
import { type ChangeSet } from '../repo/changes.js';
import { type Git, git, revParse } from '../repo/git.js';
import { testEngine } from '../testing/engine.js';

const CONFIG = parseConfig('name: A\nprefix: A\n');
const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

async function scratch(): Promise<{ root: string; repo: Git; sha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'talos-local-'));
  const repo = git(exec, root);
  await repo.run(['init', '-q']);
  await writeFile(join(root, 'talos.yml'), 'name: A\nprefix: A\n');
  await writeFile(join(root, 'a.txt'), 'a\n');
  await writeFile(join(root, 'b.txt'), 'b\n');
  await repo.run(['add', '-A']);
  await repo.run([...COMMIT, 'commit', '-q', '-m', '[A-1]: Seed']);
  return { root, repo, sha: await revParse(repo, 'HEAD') };
}

/** A check whose findings depend on the change it is judged with, as mutation's do. */
function judging(id: string, runs: { count: number }): Check {
  return {
    id,
    tier: 'head',
    scope: 'repo',
    title: id,
    applies: () => APPLIES,
    run: (ctx) => {
      runs.count += 1;
      const touched = [...(ctx.changes?.files.keys() ?? [])];
      return Promise.resolve(
        touched.map((file) => ({ rule: `${id}/r`, message: file, location: { file, line: 1 } })),
      );
    },
  };
}

function touching(path: string): ChangeSet {
  const change = { path, status: 'modified' as const, added: [], removed: [] };
  return { files: new Map([[path, { ...change, addedText: [], removedText: [] }]]) };
}

function summary(result: Awaited<ReturnType<typeof cachedRun>>): string[] {
  return result.outcomes.map((o) => `${o.check}:${o.findings.map((f) => f.message).join(',')}`);
}

describe('cachedRun', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a run apart for each --only, each change and each day', async () => {
    const { repo, sha } = await scratch();
    const runs = { count: 0 };
    const engine = testEngine([
      { name: 'p', checks: [judging('x/a', runs), judging('x/b', runs)] },
    ]);
    const at = { sha, tiers: ['head'] as const, os: 'linux' as const, side: 'base' as const };
    const base = { ...at, tiers: [...at.tiers], config: CONFIG };

    const narrow = await cachedRun(engine, repo, {
      ...base,
      only: ['x/a'],
      changes: touching('a.txt'),
    });
    expect(summary(narrow)).toEqual(['x/a:a.txt']);

    const full = await cachedRun(engine, repo, { ...base, changes: touching('b.txt') });
    expect(summary(full)).toEqual(['x/a:b.txt', 'x/b:b.txt']);
    expect(runs.count).toBe(3);

    expect(summary(await cachedRun(engine, repo, { ...base, changes: touching('b.txt') }))).toEqual(
      summary(full),
    );
    expect(runs.count).toBe(3);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    await cachedRun(engine, repo, { ...base, changes: touching('b.txt') });
    expect(runs.count).toBe(5);
  });

  it('keeps a run apart for each build it is told of', async () => {
    const { repo, sha } = await scratch();
    const runs = { count: 0 };
    const engine = testEngine([{ name: 'p', checks: [judging('x/a', runs)] }]);
    const at = { sha, tiers: ['head' as const], os: 'linux' as const, side: 'base' as const };
    await cachedRun(engine, repo, { ...at, config: CONFIG, build: 'one' });
    await cachedRun(engine, repo, { ...at, config: CONFIG, build: 'one' });
    expect(runs.count).toBe(1);
    await cachedRun(engine, repo, { ...at, config: CONFIG, build: 'two' });
    expect(runs.count).toBe(2);
  });
});

describe('runAt on the working tree', () => {
  it('judges the files as they are: deleted ones gone, new ones in', async () => {
    const { root, sha } = await scratch();
    await rm(join(root, 'b.txt'));
    await writeFile(join(root, 'c.txt'), 'c\n');
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(root, 'ignored.txt'), 'x\n');
    const seen: string[][] = [];
    const listing: Check = {
      id: 'x/files',
      tier: 'head',
      scope: 'repo',
      title: 'files',
      applies: (ctx) => {
        seen.push([...ctx.facts.files]);
        return APPLIES;
      },
      run: () => Promise.resolve([]),
    };
    await runAt(testEngine([{ name: 'p', checks: [listing] }]), {
      root,
      sha,
      tiers: ['head'],
      os: 'linux',
      side: 'head',
      workingTree: true,
    });
    expect(seen[0]?.toSorted((a, b) => a.localeCompare(b))).toEqual([
      '.gitignore',
      'a.txt',
      'c.txt',
      'talos.yml',
    ]);
  });
});

describe('runAt for the weekly mutation report', () => {
  it("mutates every component's whole tree, whatever talos.yml's mutation lists", async () => {
    const { root, sha } = await scratch();
    await writeFile(
      join(root, 'talos.yml'),
      'name: A\nprefix: A\ncomponents:\n  - { lang: ts, root: web }\n  - { lang: py, root: . }\nmutation: [web/src/risk.ts]\n',
    );
    const seen: (readonly string[])[] = [];
    const reading: Check = {
      id: 'x/mutation',
      tier: 'head',
      scope: 'repo',
      title: 'mutation',
      applies: (ctx) => {
        seen.push(ctx.config.mutation);
        return APPLIES;
      },
      run: () => Promise.resolve([]),
    };
    const engine = testEngine([{ name: 'p', checks: [reading] }]);
    const at = {
      root,
      sha,
      tiers: ['head' as const],
      os: 'linux' as const,
      side: 'alone' as const,
    };
    await runAt(engine, at);
    await runAt(engine, { ...at, mutateAll: true });
    expect(seen).toEqual([['web/src/risk.ts'], ['web', '.']]);
  });
});
