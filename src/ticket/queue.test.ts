import { beforeEach, describe, expect, it } from 'vitest';
import type { Ticketing } from './claim.js';
import { next, openClaims, queueOrder } from './queue.js';
import type { Issue } from './schemas.js';
import { FakeGitHub } from './test/fake-github.js';
import { identities } from '../github/identities.js';

const who = identities({});
const QUEUED = ['status/ready', 'ai/eligible'];

function issue(number: number, labels: string[], createdAt = '2026-10-01T00:00:00Z'): Issue {
  return {
    number,
    title: '',
    body: '',
    state: 'open',
    stateReason: undefined,
    labels,
    author: 'SvenPGH',
    association: 'OWNER',
    createdAt,
    closedAt: undefined,
    isPull: false,
  };
}

describe('queueOrder', () => {
  it('orders by priority, then age, then number', () => {
    const ordered = queueOrder([
      issue(1, [...QUEUED], '2026-10-03T00:00:00Z'),
      issue(2, [...QUEUED, 'priority/p1'], '2026-10-05T00:00:00Z'),
      issue(3, [...QUEUED, 'priority/p3'], '2026-10-01T00:00:00Z'),
      issue(4, [...QUEUED, 'priority/p0'], '2026-10-09T00:00:00Z'),
      issue(6, [...QUEUED, 'priority/p1'], '2026-10-04T00:00:00Z'),
      issue(5, [...QUEUED, 'priority/p1'], '2026-10-04T00:00:00Z'),
    ]);
    expect(ordered.map((i) => i.number)).toEqual([4, 5, 6, 2, 3, 1]);
  });

  it('leaves out what is not claimable by an agent', () => {
    const ordered = queueOrder([
      issue(1, ['status/ready']),
      issue(2, ['ai/eligible']),
      issue(3, [...QUEUED, 'blocked']),
      issue(4, [...QUEUED, 'epic']),
      issue(5, [...QUEUED, 'ai/claimed']),
      issue(6, [...QUEUED, 'status/in-progress']),
      { ...issue(7, QUEUED), isPull: true },
      { ...issue(8, QUEUED), state: 'closed' },
      issue(9, [...QUEUED, 'legacy']),
      issue(10, QUEUED),
    ]);
    expect(ordered.map((i) => i.number)).toEqual([10]);
  });
});

describe('next and openClaims', () => {
  let fake: FakeGitHub;
  let t: Ticketing;

  beforeEach(() => {
    fake = new FakeGitHub();
    t = { gh: fake.client('thea-svp[bot]'), repo: 'o/r', prefix: 'T', who, now: new Date(fake.now) };
  });

  it('counts the ticket branches whose issue is open', async () => {
    fake.addIssue({ number: 1 });
    fake.addIssue({ number: 2, state: 'closed' });
    fake.addIssue({ number: 3, pull_request: { url: 'x' } });
    for (const branch of ['T-1', 'T-2', 'T-3', 'T-4', 'T-x', 'TX-1']) fake.refs.set(branch, 's');
    expect(await openClaims(t)).toEqual([{ issue: 1, branch: 'T-1' }]);
  });

  it('refuses once the open claims reach max_claims', async () => {
    fake.addIssue({ number: 1 });
    fake.addIssue({ number: 2 });
    fake.addIssue({ number: 3, labels: [...QUEUED] });
    fake.refs.set('T-1', 's');
    fake.refs.set('T-2', 's');
    expect(await next(t, 'thea', 2)).toEqual({ result: 'max-claims', claims: 2, max: 2 });
    expect(fake.refs.has('T-3')).toBe(false);
  });

  it('claims the most urgent ticket, moving past one already taken', async () => {
    fake.addIssue({ number: 1, labels: [...QUEUED, 'priority/p2'] });
    fake.addIssue({ number: 2, labels: [...QUEUED, 'priority/p0'] });
    fake.addIssue({ number: 3, labels: [...QUEUED, 'priority/p1'] });
    fake.refs.set('T-2', 'stale-lock');
    const result = await next(t, 'thea', 5);
    expect(result).toMatchObject({ result: 'claimed', issue: 3 });
    expect(fake.refs.get('T-3')).toBe('sha-main');
  });

  it('answers empty when nothing in the queue can be claimed', async () => {
    fake.addIssue({ number: 1, labels: ['status/ready'] });
    expect(await next(t, 'thea', 2)).toEqual({ result: 'empty', tried: 0 });
  });
});
