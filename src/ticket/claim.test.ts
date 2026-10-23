import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentProblem,
  branchFor,
  claim,
  claimantOf,
  claimLine,
  claimRefusal,
  issueOfBranch,
  reasonProblem,
  release,
  releasedLabels,
  type Ticketing,
} from './claim.js';
import type { Comment, Issue } from './schemas.js';
import { FakeGitHub } from './test/fake-github.js';
import { identities } from '../github/identities.js';

const who = identities({});
const THEA = 'thea-svp[bot]';
const NOW = new Date('2026-10-23T10:00:00.123Z');

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 7,
    title: 'T',
    body: '',
    state: 'open',
    stateReason: undefined,
    labels: ['feature', 'status/ready'],
    author: 'SvenPGH',
    association: 'OWNER',
    createdAt: '2026-10-01T00:00:00Z',
    closedAt: undefined,
    isPull: false,
    ...overrides,
  };
}

function comment(body: string, author: string, association = 'NONE'): Comment {
  return { id: 1, body, author, association, createdAt: '2026-10-02T00:00:00Z' };
}

describe('branches', () => {
  it('names a ticket branch <P>-<N> and reads it back', () => {
    expect(branchFor('T', 42)).toBe('T-42');
    expect(issueOfBranch('T', 'T-42')).toBe(42);
    expect(issueOfBranch('TL', 'TL-1')).toBe(1);
  });

  it('reads no issue from any other branch', () => {
    for (const branch of ['T-0', 'T-01', 'T-42a', 'TL-1x', 'X-1', 'T-', 'thea/x', 'T-1234567890']) {
      expect(issueOfBranch('T', branch), branch).toBeUndefined();
    }
  });
});

describe('agentProblem and reasonProblem', () => {
  it('accepts plain agent ids', () => {
    for (const agent of ['thea', 'sven', 'gha-123', 'a.b_c']) expect(agentProblem(agent)).toBeUndefined();
  });

  it('refuses ids that could forge a line or the approval marker', () => {
    expect(agentProblem('two words')).toBeDefined();
    expect(agentProblem('')).toBeDefined();
    expect(agentProblem('-dash')).toBeDefined();
    expect(agentProblem('x'.repeat(40))).toBeDefined();
    expect(agentProblem('talos-approve')).toMatch(/talos-approve/);
  });

  it('takes one short line as a reason, without the approval marker', () => {
    expect(reasonProblem('the criteria are ambiguous')).toBeUndefined();
    expect(reasonProblem(' ')).toBeDefined();
    expect(reasonProblem('a\nb')).toBeDefined();
    expect(reasonProblem('x'.repeat(201))).toBeDefined();
    expect(reasonProblem('talos-approve card abc')).toMatch(/talos-approve/);
  });
});

describe('claimLine and claimantOf', () => {
  it('writes the claim comment with a time to the second', () => {
    expect(claimLine('thea', NOW)).toBe('🔒 claimed by thea · 2026-10-23T10:00:00Z');
  });

  it('reads the latest claim a trusted author wrote', () => {
    const comments = [
      comment(claimLine('sven', NOW), 'SvenPGH', 'OWNER'),
      comment('🔒 claimed by mallory · 2026-10-23T11:00:00Z', 'mallory', 'NONE'),
      comment(claimLine('thea', NOW), THEA),
      comment('a later remark', 'SvenPGH', 'OWNER'),
    ];
    expect(claimantOf(comments, who)).toEqual({ agent: 'thea', at: '2026-10-23T10:00:00Z' });
    expect(claimantOf(comments.slice(0, 2), who)?.agent).toBe('sven');
  });

  it('finds none without a trusted claim comment', () => {
    expect(claimantOf([], who)).toBeUndefined();
    expect(claimantOf([comment('🔒 claimed by x · now', 'stranger')], who)).toBeUndefined();
  });
});

describe('claimRefusal', () => {
  it('lets an open, ready issue be claimed', () => {
    expect(claimRefusal(issue())).toBeUndefined();
  });

  it.each([
    [undefined, 'not-found'],
    [issue({ isPull: true }), 'not-an-issue'],
    [issue({ state: 'closed' }), 'closed'],
    [issue({ labels: ['feature'] }), 'not-ready'],
    [issue({ labels: ['status/ready', 'blocked'] }), 'blocked'],
    [issue({ labels: ['status/ready', 'legacy'] }), 'legacy'],
    [issue({ labels: ['status/ready', 'needs-decision'] }), 'needs-decision'],
    [issue({ labels: ['status/ready', 'needs-spec'] }), 'needs-spec'],
    [issue({ labels: ['status/ready', 'epic'] }), 'epic'],
  ])('refuses %#', (given, reason) => {
    expect(claimRefusal(given)).toBe(reason);
  });
});

describe('releasedLabels', () => {
  it('drops the claim labels and makes an open ticket ready again', () => {
    expect(releasedLabels(issue({ labels: ['bug', 'status/in-progress', 'ai/claimed'] }))).toEqual({
      add: ['status/ready'],
      remove: ['status/in-progress', 'ai/claimed'],
    });
  });

  it('does not make ready a closed issue, one that needs a spec, or an epic', () => {
    for (const given of [
      issue({ state: 'closed', labels: ['ai/claimed'] }),
      issue({ labels: ['needs-spec'] }),
      issue({ labels: ['epic'] }),
      issue({ labels: ['status/ready'] }),
    ]) {
      expect(releasedLabels(given).add).toEqual([]);
    }
  });
});

describe('claim and release against GitHub', () => {
  let fake: FakeGitHub;
  let t: Ticketing;

  beforeEach(() => {
    fake = new FakeGitHub();
    fake.addIssue({ number: 7, title: 'Fix it', body: '## Goal\nx', labels: ['bug', 'status/ready'] });
    t = { gh: fake.client(THEA), repo: 'o/r', prefix: 'T', who, now: NOW };
  });

  it('claims: the branch at the default head, the labels, the comment, the payload', async () => {
    const result = await claim(t, 7, 'thea');
    expect(result.result).toBe('claimed');
    expect(fake.refs.get('T-7')).toBe('sha-main');
    expect(fake.issues.get(7)?.labels).toEqual(['bug', 'status/in-progress', 'ai/claimed']);
    expect(fake.issues.get(7)?.comments.at(-1)?.body).toBe(claimLine('thea', NOW));
    expect(result).toMatchObject({
      result: 'claimed',
      ticket: {
        branch: 'T-7',
        agent: 'thea',
        number: 7,
        title: 'Fix it',
        labels: ['bug', 'status/in-progress', 'ai/claimed'],
        body: '## Goal\nx',
        commentsTotal: 1,
      },
    });
  });

  it('answers taken, naming the claimant, when the branch exists', async () => {
    await claim({ ...t, gh: fake.client('SvenPGH') }, 7, 'sven');
    fake.issues.get(7)?.labels.push('status/ready');
    expect(await claim(t, 7, 'thea')).toEqual({ result: 'taken', by: 'sven' });
  });

  it('refuses without touching GitHub when the issue is not claimable', async () => {
    fake.addIssue({ number: 8, labels: ['bug'] });
    expect(await claim(t, 8, 'thea')).toEqual({ result: 'refused', reason: 'not-ready' });
    expect(await claim(t, 99, 'thea')).toEqual({ result: 'refused', reason: 'not-found' });
    expect(fake.writes()).toEqual([]);
  });

  it('rethrows a 422 that is not an existing branch', async () => {
    fake.failures.set('POST repos/o/r/git/refs', 422);
    await expect(claim(t, 7, 'thea')).rejects.toThrow(/422/);
  });

  it('gives the branch back when the labels cannot be set', async () => {
    fake.failures.set('POST repos/o/r/issues/7/labels', 500);
    await expect(claim(t, 7, 'thea')).rejects.toThrow(/500/);
    expect(fake.refs.has('T-7')).toBe(false);
  });

  it('releases: branch deleted, ready again, a comment', async () => {
    await claim(t, 7, 'thea');
    const result = await release(t, 7, 'the criteria are ambiguous');
    expect(result).toEqual({ result: 'released', branch: 'T-7', deleted: true });
    expect(fake.refs.has('T-7')).toBe(false);
    expect(fake.issues.get(7)?.labels).toEqual(['bug', 'status/ready']);
    expect(fake.issues.get(7)?.comments.at(-1)?.body).toBe('🔓 released: the criteria are ambiguous');
  });

  it('repairs the labels even when the branch is already gone', async () => {
    fake.issues.get(7)?.labels.splice(0, 2, 'bug', 'ai/claimed');
    expect(await release(t, 7, 'repair')).toEqual({ result: 'released', branch: 'T-7', deleted: false });
    expect(fake.issues.get(7)?.labels).toEqual(['bug', 'status/ready']);
  });

  it('refuses to release while a PR is open from the branch', async () => {
    await claim(t, 7, 'thea');
    fake.pulls.push({ number: 12, draft: true, state: 'open', updated_at: fake.now, head: 'T-7' });
    expect(await release(t, 7, 'x')).toEqual({ result: 'refused', reason: 'open-pr', pr: 12 });
    expect(fake.refs.has('T-7')).toBe(true);
  });

  it('refuses to release a pull request or a missing issue', async () => {
    fake.addIssue({ number: 9, pull_request: { url: 'x' } });
    expect(await release(t, 9, 'x')).toEqual({ result: 'refused', reason: 'not-found' });
    expect(await release(t, 99, 'x')).toEqual({ result: 'refused', reason: 'not-found' });
  });
});
