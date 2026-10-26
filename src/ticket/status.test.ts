import { describe, expect, it } from 'vitest';
import { claimLine } from './claim.js';
import { checksState, pullStage, ticketStatus } from './status.js';
import { FakeGitHub } from './test/fake-github.js';
import { identities } from '../github/identities.js';

const who = identities({});

describe('pullStage', () => {
  it('names each stage in the words talos status uses', () => {
    expect(pullStage({ state: 'MERGED', isDraft: false, inQueue: false })).toBe('merged');
    expect(pullStage({ state: 'CLOSED', isDraft: true, inQueue: false })).toBe('closed');
    expect(pullStage({ state: 'OPEN', isDraft: true, inQueue: false })).toBe('draft');
    expect(pullStage({ state: 'OPEN', isDraft: false, inQueue: true })).toBe('queued');
    expect(pullStage({ state: 'OPEN', isDraft: false, inQueue: false })).toBe('ready');
  });
});

describe('checksState', () => {
  it.each([
    ['SUCCESS', 'green'],
    ['FAILURE', 'red'],
    ['ERROR', 'red'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
    [undefined, 'none'],
    ['SOMETHING_NEW', 'none'],
  ])('%s is %s', (rollup, state) => {
    expect(checksState(rollup)).toBe(state);
  });
});

describe('ticketStatus', () => {
  it('reports the claim, the last commit and the PR', async () => {
    const fake = new FakeGitHub();
    fake.addIssue({ number: 7, labels: ['bug', 'ai/claimed'] });
    fake.issues.get(7)?.comments.push({
      id: 1,
      body: claimLine('thea', new Date('2026-10-23T08:00:00Z')),
      user: 'thea-svp[bot]',
      author_association: 'NONE',
      created_at: '2026-10-23T08:00:00Z',
    });
    fake.refs.set('T-7', 'abc');
    fake.commitDates.set('abc', '2026-10-23T09:00:00Z');
    let asked: Record<string, unknown> = {};
    fake.graphql = (_query, variables) => {
      asked = variables;
      return {
        repository: {
          pullRequests: {
            nodes: [
              {
                number: 12,
                isDraft: false,
                state: 'OPEN',
                mergeQueueEntry: { state: 'QUEUED' },
                commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
              },
            ],
          },
        },
      };
    };
    const status = await ticketStatus(
      { gh: fake.client(), repo: 'o/r', prefix: 'T', who, now: new Date() },
      7,
    );
    expect(asked).toEqual({ owner: 'o', name: 'r', branch: 'T-7' });
    expect(status).toEqual({
      result: 'status',
      issue: 7,
      branch: 'T-7',
      state: 'open',
      labels: ['bug', 'ai/claimed'],
      claimed: true,
      agent: 'thea',
      since: '2026-10-23T08:00:00Z',
      lastCommit: { sha: 'abc', date: '2026-10-23T09:00:00Z' },
      pr: { number: 12, stage: 'queued', checks: 'pending' },
    });
  });

  it('reports an unclaimed ticket with no PR', async () => {
    const fake = new FakeGitHub();
    fake.graphql = () => ({ repository: { pullRequests: { nodes: [] } } });
    const status = await ticketStatus(
      { gh: fake.client(), repo: 'o/r', prefix: 'T', who, now: new Date() },
      3,
    );
    expect(status).toMatchObject({
      state: null,
      claimed: false,
      agent: null,
      lastCommit: null,
      pr: null,
    });
  });
});
