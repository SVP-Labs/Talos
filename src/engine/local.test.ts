import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedRun, changesBetween, runAt } from './local.js';
import { decide, statusOf } from './verdict.js';
import { parseConfig } from '../config/load.js';
import { APPLIES, type Check, EngineError } from '../core/check.js';
import type { Pack } from '../core/pack.js';
import { type Exec, exec } from '../exec/exec.js';
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

describe('an adoption PR', () => {
  /** A linter whose generated config imports the project's extension file, as ESLint's does. */
  const linting: Pack = {
    name: 'lint',
    generated: [
      {
        path: 'lint.config.txt',
        scope: 'repo',
        applies: () => true,
        render: () => 'lint.project.txt\n',
        extension: { path: 'lint.project.txt', initial: () => '' },
      },
    ],
    checks: [
      {
        id: 'x/lint',
        tier: 'head',
        scope: 'repo',
        title: 'lint',
        applies: () => APPLIES,
        run: async (ctx) => {
          const imported = (await readFile(join(ctx.root, 'lint.config.txt'), 'utf8')).trim();
          await readFile(join(ctx.root, imported)).catch(() => {
            throw new EngineError(`Cannot find module ${imported}`);
          });
          const sources = ctx.facts.files.filter((file) => file.startsWith('src/'));
          const texts = await Promise.all(sources.map((f) => readFile(join(ctx.root, f), 'utf8')));
          return sources.flatMap((file, index) =>
            (texts[index] ?? '').includes('debt')
              ? [{ rule: 'x/debt', message: 'debt', location: { file, line: 1 } }]
              : [],
          );
        },
      },
    ],
  };

  async function commit(repo: Git, files: Readonly<Record<string, string>>): Promise<string> {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo.root, path)), { recursive: true });
      await writeFile(join(repo.root, path), text);
    }
    await repo.run(['add', '-A']);
    await repo.run([...COMMIT, 'commit', '-q', '-m', '[A-1]: Change']);
    return revParse(repo, 'HEAD');
  }

  it('judges only what the PR adds, though the base lacks the files adoption adds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talos-adopt-'));
    const repo = git(exec, root);
    await repo.run(['init', '-q']);
    const base = await commit(repo, { 'src/old.txt': 'debt\n' });
    const yml = 'name: A\nprefix: A\nsetup: scripts/talos-setup.sh\n';
    const head = await commit(repo, {
      'talos.yml': yml,
      'scripts/talos-setup.sh': 'true\n',
      'lint.config.txt': 'lint.project.txt\n',
      'lint.project.txt': '',
      'src/new.txt': 'debt\n',
    });
    const setups: string[] = [];
    const engine = {
      ...testEngine([linting]),
      exec: ((command, args, options) => {
        if (command !== 'bash') return exec(command, args, options);
        setups.push(args.join(' '));
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }) satisfies Exec,
    };
    const changes = await changesBetween(repo, base, head);
    const common = { tiers: ['head' as const], os: 'linux' as const, changes };
    const results = [
      await cachedRun(engine, repo, {
        ...common,
        sha: base,
        side: 'base',
        config: parseConfig(yml),
      }),
      await runAt(engine, { ...common, root, sha: head, side: 'head' }),
    ];
    const verdict = decide(results, [{ sha: head, against: base, tier: 'head', changes }], []);
    expect(verdict.faults).toEqual([]);
    expect(verdict.findings.map((f) => [f.location?.file, f.isNew])).toEqual([
      ['src/new.txt', true],
      ['src/old.txt', false],
    ]);
    expect(verdict.blocking.map((f) => f.location?.file)).toEqual(['src/new.txt']);
    expect(statusOf(verdict)).toBe('red');
    expect(setups).toEqual([join(root, 'scripts/talos-setup.sh')]);
  });
});
