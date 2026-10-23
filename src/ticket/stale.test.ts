import { beforeEach, describe, expect, it } from 'vitest';
import { STALE_HOURS, staleness, sweepStaleClaims, ticketBranches } from './stale.js';
import { FakeGitHub } from './test/fake-github.js';

const NOW = new Date('2026-10-23T10:00:00Z');

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

describe('staleness', () => {
  it('never calls a claim with a ready PR stale', () => {
    expect(staleness({ readyPull: true, claimedAt: hoursAgo(100) }, NOW)).toEqual({
      stale: false,
      idleHours: null,
      why: 'in-review',
    });
  });

  it('keeps a claim it knows no time for', () => {
    expect(staleness({ readyPull: false }, NOW).why).toBe('no-activity-known');
    expect(staleness({ readyPull: false, pushedAt: 'not a date' }, NOW).why).toBe(
      'no-activity-known',
    );
  });

  it('measures idle time from the newest of claim, push and draft update', () => {
    const active = staleness(
      { readyPull: false, claimedAt: hoursAgo(30), pushedAt: hoursAgo(50), draftUpdatedAt: hoursAgo(1) },
      NOW,
    );
    expect(active).toEqual({ stale: false, idleHours: 1, why: 'active' });
    const idle = staleness(
      { readyPull: false, claimedAt: hoursAgo(5), pushedAt: hoursAgo(400) },
      NOW,
    );
    expect(idle).toEqual({ stale: true, idleHours: 5, why: 'idle' });
  });

  it(`releases only past ${STALE_HOURS} hours`, () => {
    expect(staleness({ readyPull: false, claimedAt: hoursAgo(STALE_HOURS) }, NOW).stale).toBe(false);
    expect(staleness({ readyPull: false, claimedAt: hoursAgo(STALE_HOURS + 0.01) }, NOW).stale).toBe(
      true,
    );
  });

  it('reads a time in the future as no idle time', () => {
    expect(staleness({ readyPull: false, pushedAt: hoursAgo(-2) }, NOW)).toEqual({
      stale: false,
      idleHours: 0,
      why: 'active',
    });
  });
});

describe('sweepStaleClaims', () => {
  let fake: FakeGitHub;

  function claimed(number: number, claimedHoursAgo: number): void {
    fake.addIssue({
      number,
      labels: ['bug', 'status/in-progress', 'ai/claimed'],
      timeline: [
        { event: 'labeled', created_at: hoursAgo(claimedHoursAgo + 1), label: { name: 'status/in-progress' } },
        { event: 'labeled', created_at: hoursAgo(claimedHoursAgo), label: { name: 'status/in-progress' } },
        { event: 'commented', created_at: hoursAgo(0) },
      ],
    });
    fake.refs.set(`T-${number}`, 'sha-main');
  }

  beforeEach(() => {
    fake = new FakeGitHub();
  });

  async function sweep(): Promise<Awaited<ReturnType<typeof sweepStaleClaims>>> {
    return sweepStaleClaims(
      { gh: fake.client('talos-reviewer[bot]'), refs: fake.client('github-actions[bot]') },
      { repo: 'o/r', prefix: 'T', now: NOW },
    );
  }

  it('lists only ticket branches', async () => {
    fake.refs.set('T-3', 's');
    fake.refs.set('T-x', 's');
    fake.refs.set('TL-4', 's');
    expect(await ticketBranches(fake.client(), 'o/r', 'T')).toEqual([{ branch: 'T-3', issue: 3 }]);
  });

  it('releases an idle claim and closes its draft PR', async () => {
    claimed(1, 6);
    fake.pulls.push({ number: 20, draft: true, state: 'open', updated_at: hoursAgo(7), head: 'T-1' });
    expect(await sweep()).toEqual({ released: [1], kept: 0, failed: 0 });
    expect(fake.refs.has('T-1')).toBe(false);
    expect(fake.pulls[0]?.state).toBe('closed');
    expect(fake.issues.get(1)?.labels).toEqual(['bug', 'status/ready']);
    expect(fake.issues.get(1)?.comments.at(-1)?.body).toMatch(/^🔓 released: the claim was idle for 6 h/);
    expect(fake.issues.get(20)?.comments.at(-1)?.body).toMatch(/^Closed by Talos: the claim on #1/);
    const deletion = fake.calls.find((c) => c.method === 'DELETE' && c.path.includes('git/refs'));
    expect(deletion?.login).toBe('github-actions[bot]');
  });

  it('keeps active claims, ready PRs, and branches that are no ticket', async () => {
    claimed(1, 1);
    claimed(2, 30);
    fake.pulls.push({ number: 21, draft: false, state: 'open', updated_at: hoursAgo(30), head: 'T-2' });
    fake.refs.set('T-3', 'sha-main');
    fake.addIssue({ number: 4, pull_request: { url: 'x' } });
    fake.refs.set('T-4', 'sha-main');
    expect(await sweep()).toEqual({ released: [], kept: 4, failed: 0 });
    expect(fake.writes()).toEqual([]);
  });

  it('cleans up after a closed issue without asking anyone to claim it', async () => {
    claimed(1, 10);
    const issue = fake.issues.get(1);
    if (issue !== undefined) issue.state = 'closed';
    expect((await sweep()).released).toEqual([1]);
    expect(fake.issues.get(1)?.labels).toEqual(['bug']);
    expect(fake.issues.get(1)?.comments).toEqual([]);
  });

  it('counts a claim it could not release, and goes on', async () => {
    claimed(1, 10);
    claimed(2, 10);
    fake.failures.set('DELETE repos/o/r/git/refs/heads/T-1', 403);
    expect(await sweep()).toEqual({ released: [2], kept: 0, failed: 1 });
    expect(fake.issues.get(1)?.labels).toContain('ai/claimed');
  });
});
