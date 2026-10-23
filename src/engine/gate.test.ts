import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { commitFindings, comparisonsFor } from './gate.js';
import type { GatePlan } from './plan.js';
import { parseConfig } from '../config/load.js';
import { exec } from '../exec/exec.js';
import { type Git, git, mergeBase, revList } from '../repo/git.js';

/** `git commit` as a throwaway identity, unsigned, whatever the machine's git config says. */
const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

type History = {
  readonly repo: Git;
  readonly base: string;
  readonly first: string;
  readonly second: string;
};

/** A throwaway repository, and a commit of one file whose text is the commit's subject. */
async function scratch(
  name: string,
): Promise<{ repo: Git; commit: (path: string, subject: string) => Promise<string> }> {
  const cwd = await mkdtemp(join(tmpdir(), name));
  const repo = git(exec, cwd);
  const commit = async (path: string, subject: string): Promise<string> => {
    await writeFile(join(cwd, path), `${subject}\n`);
    await repo.run(['add', '-A']);
    await repo.run([...COMMIT, 'commit', '-q', '-m', subject]);
    return (await repo.run(['rev-parse', 'HEAD'])).trim();
  };
  return { repo, commit };
}

async function history(): Promise<History> {
  const { repo, commit } = await scratch('talos-gate-');
  await repo.run(['init', '-q']);
  const base = await commit('talos.yml', '[A-1]: Adopt Talos');
  const first = await commit('a.txt', '[A-1]: Add a');
  const second = await commit('b.txt', 'add b');
  return { repo, base, first, second };
}

function planOf(h: History, overrides: Partial<GatePlan> = {}): GatePlan {
  return {
    mode: 'ready',
    base: h.base,
    head: h.second,
    commits: [h.first, h.second],
    branch: 'A-1',
    runs: [],
    ...overrides,
  };
}

const CONFIG = parseConfig('name: A\nprefix: A\n');
const DEPENDABOT_EMAIL = '49699333+dependabot[bot]@users.noreply.github.com';

describe('comparisonsFor', () => {
  let h: History;
  beforeAll(async () => {
    h = await history();
  });

  it('compares head with base, and each commit with its parent', async () => {
    const comparisons = await comparisonsFor(h.repo, planOf(h));
    expect(comparisons.map((c) => [c.tier, c.sha, c.against])).toEqual([
      ['head', h.second, h.base],
      ['commit', h.first, h.base],
      ['commit', h.second, h.first],
    ]);
    const changed = [...(comparisons[0]?.changes.files.keys() ?? [])];
    expect(changed.toSorted((a, b) => a.localeCompare(b))).toEqual(['a.txt', 'b.txt']);
    expect([...(comparisons[2]?.changes.files.keys() ?? [])]).toEqual(['b.txt']);
  });

  it('judges no commit against a base that was never its parent', async () => {
    const comparisons = await comparisonsFor(h.repo, planOf(h, { commits: [h.second] }));
    expect(comparisons.map((c) => [c.tier, c.sha, c.against])).toEqual([
      ['head', h.second, h.base],
    ]);
  });

  it('judges a draft as one change, at both tiers', async () => {
    const comparisons = await comparisonsFor(h.repo, planOf(h, { mode: 'draft' }));
    expect(comparisons.map((c) => [c.tier, c.sha, c.against])).toEqual([
      ['head', h.second, h.base],
      ['commit', h.second, h.base],
    ]);
  });
});

type Merged = {
  readonly repo: Git;
  readonly plan: GatePlan;
  readonly own: string;
  readonly merge: string;
  readonly after: string;
};

/** A ready PR whose branch merged main after main fixed something: own, merge, after. */
async function mergedMain(): Promise<Merged> {
  const { repo, commit } = await scratch('talos-gate-merge-');
  await repo.run(['init', '-q', '-b', 'main']);
  await commit('talos.yml', '[A-1]: Adopt Talos');
  await repo.run(['checkout', '-q', '-b', 'A-2']);
  const own = await commit('own.txt', '[A-2]: Add own');
  await repo.run(['checkout', '-q', 'main']);
  const fixed = await commit('fixed.txt', '[A-3]: Fix main');
  await repo.run(['checkout', '-q', 'A-2']);
  await repo.run([...COMMIT, 'merge', '-q', '--no-edit', 'main']);
  const merge = (await repo.run(['rev-parse', 'HEAD'])).trim();
  const after = await commit('after.txt', '[A-2]: Add after');
  const base = await mergeBase(repo, fixed, after);
  const commits = await revList(repo, base, after);
  const plan: GatePlan = { mode: 'ready', base, head: after, commits, branch: 'A-2', runs: [] };
  return { repo, plan, own, merge, after };
}

describe('a PR whose branch merged main', () => {
  let m: Merged;
  beforeAll(async () => {
    m = await mergedMain();
  });

  it("judges no commit against main's changes, and none against the merge's parents", async () => {
    expect(m.plan.commits).toEqual([m.own, m.merge, m.after]);
    const comparisons = await comparisonsFor(m.repo, m.plan);
    expect(comparisons.map((c) => [c.tier, c.sha, c.against])).toEqual([
      ['head', m.after, m.plan.base],
      ['commit', m.after, m.merge],
    ]);
    const changed = [...(comparisons[0]?.changes.files.keys() ?? [])];
    expect(changed.toSorted((a, b) => a.localeCompare(b))).toEqual(['after.txt', 'own.txt']);
  });

  it('reports the merge commit itself, asking for a rebase, and judges its subject no further', async () => {
    const findings = await commitFindings(m.repo, m.plan, CONFIG);
    expect(findings.map((f) => [f.sha, f.rule, f.check, f.policy])).toEqual([
      [m.merge, 'commit/merge', 'process/commits', 'always'],
    ]);
    expect(findings[0]?.message).toMatch(/rebase instead of merging/);
  });
});

describe('commitFindings', () => {
  let h: History;
  beforeAll(async () => {
    h = await history();
  });

  it("reports each commit's subject against the format and the branch's ticket", async () => {
    const findings = await commitFindings(h.repo, planOf(h, { branch: 'A-2' }), CONFIG);
    expect(findings.map((f) => [f.sha, f.rule, f.check, f.policy])).toEqual([
      [h.first, 'commit/ticket', 'process/commits', 'always'],
      [h.second, 'commit/subject', 'process/commits', 'always'],
    ]);
    expect(findings.every((f) => /^[0-9a-f]+$/.test(f.fingerprint))).toBe(true);
  });

  it("exempts Dependabot's commits on its own PRs and in the merge queue, never by email alone", async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'talos-gate-bot-'));
    const repo = git(exec, cwd);
    const as = ['-c', 'user.name=dependabot[bot]', '-c', `user.email=${DEPENDABOT_EMAIL}`];
    await repo.run(['init', '-q']);
    await writeFile(join(cwd, 'a.txt'), 'a\n');
    await repo.run(['add', '-A']);
    await repo.run([...COMMIT, ...as, 'commit', '-q', '-m', 'Bump x from 1 to 2']);
    const sha = (await repo.run(['rev-parse', 'HEAD'])).trim();
    const plan = (overrides: Partial<GatePlan>): GatePlan => ({
      mode: 'ready',
      base: sha,
      head: sha,
      commits: [sha],
      runs: [],
      ...overrides,
    });
    const rules = async (overrides: Partial<GatePlan>): Promise<string[]> =>
      (await commitFindings(repo, plan(overrides), CONFIG)).map((f) => f.rule);
    expect(await rules({ author: 'dependabot[bot]' })).toEqual([]);
    expect(await rules({ mode: 'merge-group' })).toEqual([]);
    expect(await rules({ author: 'someone' })).toEqual(['commit/subject']);
    expect(await rules({})).toEqual(['commit/subject']);
  });

  it('judges only the head commit of a draft', async () => {
    const findings = await commitFindings(h.repo, planOf(h, { mode: 'draft' }), CONFIG);
    expect(findings.map((f) => [f.sha, f.rule])).toEqual([[h.second, 'commit/subject']]);
  });

  it('reads the words the glossary says to avoid', async () => {
    await writeFile(join(h.repo.root, 'glossary.md'), '**addition**\n\nAvoid: add\n');
    const config = parseConfig('name: A\nprefix: A\ndocs:\n  glossary: glossary.md\n');
    const plan = planOf(h, { commits: [h.first] });
    const rules = (await commitFindings(h.repo, plan, config)).map((f) => f.rule);
    expect(rules).toEqual(['glossary/avoid']);
    expect((await commitFindings(h.repo, plan, CONFIG)).map((f) => f.rule)).toEqual([]);
  });
});
