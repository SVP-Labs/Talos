import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { commitFindings, comparisonsFor } from './gate.js';
import type { GatePlan } from './plan.js';
import { parseConfig } from '../config/load.js';
import { exec } from '../exec/exec.js';
import { type Git, git } from '../repo/git.js';

/** `git commit` as a throwaway identity, unsigned, whatever the machine's git config says. */
const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

type History = {
  readonly repo: Git;
  readonly base: string;
  readonly first: string;
  readonly second: string;
};

async function history(): Promise<History> {
  const cwd = await mkdtemp(join(tmpdir(), 'talos-gate-'));
  const repo = git(exec, cwd);
  const commit = async (path: string, subject: string): Promise<string> => {
    await writeFile(join(cwd, path), `${subject}\n`);
    await repo.run(['add', '-A']);
    await repo.run([...COMMIT, 'commit', '-q', '-m', subject]);
    return (await repo.run(['rev-parse', 'HEAD'])).trim();
  };
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

  it('compares a commit whose parent is outside the range with the base', async () => {
    const comparisons = await comparisonsFor(h.repo, planOf(h, { commits: [h.second] }));
    expect(comparisons.map((c) => [c.tier, c.sha, c.against])).toEqual([
      ['head', h.second, h.base],
      ['commit', h.second, h.base],
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
