import { describe, expect, it } from 'vitest';
import { isGateFile, queueGateRuns } from './gate-runs.js';
import { FakeGitHub } from '../ticket/test/fake-github.js';

const GATE = { path: '.github/workflows/gate.yml', repositoryName: 'SVP-Labs/Talos' };

describe('isGateFile', () => {
  it("is Talos's gate file in the Talos repository, and nothing else", () => {
    expect(isGateFile(GATE, 'SVP-Labs/Talos')).toBe(true);
    expect(
      isGateFile(
        { ...GATE, repositoryName: 'https://github.com/svp-labs/talos' },
        'SVP-Labs/Talos',
      ),
    ).toBe(true);
    expect(isGateFile({ ...GATE, repositoryName: 'SVP-Labs/App' }, 'SVP-Labs/Talos')).toBe(false);
    expect(isGateFile({ ...GATE, path: '.github/workflows/mine.yml' }, 'SVP-Labs/Talos')).toBe(
      false,
    );
    expect(isGateFile(null, 'SVP-Labs/Talos')).toBe(false);
  });
});

describe('queueGateRuns', () => {
  it("lists the gate's merge-queue runs since a day, newest first, by their workflow file", async () => {
    const fake = new FakeGitHub();
    fake.graphql = (_query, variables) => fake.runNodes(variables);
    const run = (id: number, created: string, file = GATE, event = 'merge_group') => ({
      id,
      event,
      created_at: created,
      head_branch: `gh-readonly-queue/main/pr-${id}-${'a'.repeat(40)}`,
      file,
    });
    fake.runs.push(
      run(1, '2026-10-25T01:00:00Z'),
      run(2, '2026-10-25T02:00:00Z', { ...GATE, repositoryName: 'o/r' }),
      run(3, '2026-10-25T03:00:00Z', GATE, 'pull_request'),
      run(4, '2026-10-20T00:00:00Z'),
      run(5, '2026-10-26T00:00:00Z'),
    );
    const runs = await queueGateRuns(fake.client(), 'o/r', {
      since: new Date('2026-10-24T03:17:00Z'),
      talosRepo: 'SVP-Labs/Talos',
    });
    expect(runs.map((r) => [r.id, r.headBranch.slice(0, 26)])).toEqual([
      [5, 'gh-readonly-queue/main/pr-'],
      [1, 'gh-readonly-queue/main/pr-'],
    ]);
  });

  it('asks GraphQL nothing when the queue ran nothing', async () => {
    const fake = new FakeGitHub();
    let asked = 0;
    fake.graphql = () => {
      asked += 1;
      return { nodes: [] };
    };
    const at = { since: new Date('2026-10-24T00:00:00Z'), talosRepo: 'SVP-Labs/Talos' };
    expect(await queueGateRuns(fake.client(), 'o/r', at)).toEqual([]);
    expect(asked).toBe(0);
  });
});
