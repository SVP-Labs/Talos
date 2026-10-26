import { describe, expect, it } from 'vitest';
import { type ApprovalFacts, current, ownerApproval, theaCard } from './approval.js';
import type { PullCommit, Review } from './types.js';

const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const OWNER = 'SvenPGH';
const THEA = 'thea-svp[bot]';

function review(overrides: Partial<Review> = {}): Review {
  return {
    author: OWNER,
    state: 'APPROVED',
    commitId: HEAD,
    submittedAt: '2026-10-23T10:00:00Z',
    body: '',
    ...overrides,
  };
}

function signed(overrides: Partial<PullCommit> = {}): PullCommit {
  return { sha: 's1', verified: true, author: OWNER, committer: OWNER, ...overrides };
}

function facts(overrides: Partial<ApprovalFacts> = {}): ApprovalFacts {
  return {
    headSha: HEAD,
    lastPushAt: undefined,
    reviews: [],
    commits: [signed({ author: THEA, committer: THEA })],
    commitCount: 1,
    author: THEA,
    owners: [OWNER],
    thea: THEA,
    theaCounts: true,
    ...overrides,
  };
}

const card = (overrides: Partial<Review> = {}): Review =>
  review({ author: THEA, state: 'COMMENTED', body: `talos-approve card-7 ${HEAD}`, ...overrides });

describe('the owner approving on GitHub', () => {
  it('counts a code owner APPROVE of the head', () => {
    expect(ownerApproval(facts({ reviews: [review()] }))).toEqual({
      approved: true,
      line: 'the owner approved: @SvenPGH on GitHub',
    });
  });

  it('ignores an APPROVE of an older commit', () => {
    expect(ownerApproval(facts({ reviews: [review({ commitId: OLD })] })).approved).toBe(false);
  });

  it('ignores an APPROVE from before the last force-push or base change', () => {
    const before = facts({ reviews: [review()], lastPushAt: '2026-10-23T11:00:00Z' });
    expect(ownerApproval(before)).toEqual({
      approved: false,
      line: 'the owner has not approved the head',
    });
    const after = facts({ reviews: [review()], lastPushAt: '2026-10-23T09:00:00Z' });
    expect(ownerApproval(after).approved).toBe(true);
  });

  it('ignores an APPROVE at the very moment of the push', () => {
    const same = facts({ reviews: [review()], lastPushAt: '2026-10-23T10:00:00Z' });
    expect(ownerApproval(same).approved).toBe(false);
  });

  it('ignores an APPROVE from anyone but a code owner', () => {
    expect(ownerApproval(facts({ reviews: [review({ author: 'someone' })] })).approved).toBe(false);
  });

  it('lets a later request for changes or a dismissal override the APPROVE', () => {
    const changes = review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-23T10:05:00Z' });
    expect(ownerApproval(facts({ reviews: [review(), changes] })).approved).toBe(false);
    expect(ownerApproval(facts({ reviews: [review({ state: 'DISMISSED' })] })).approved).toBe(
      false,
    );
  });

  it('keeps the APPROVE through a later plain comment', () => {
    const comment = review({ state: 'COMMENTED', submittedAt: '2026-10-23T10:05:00Z' });
    expect(ownerApproval(facts({ reviews: [review(), comment] })).approved).toBe(true);
  });

  it("compares logins without case, as GitHub's CODEOWNERS does", () => {
    expect(
      ownerApproval(facts({ owners: [OWNER.toLowerCase()], reviews: [review()] })).approved,
    ).toBe(true);
    expect(
      ownerApproval(
        facts({
          owners: [OWNER.toLowerCase()],
          author: OWNER,
          commits: [signed({ author: OWNER.toUpperCase() })],
        }),
      ).approved,
    ).toBe(true);
    expect(theaCard(card(), facts({ thea: 'Thea-SVP[bot]' }))).toBe('card-7');
  });

  it('counts any of several code owners', () => {
    const reviews = [review({ author: 'other-owner' })];
    expect(ownerApproval(facts({ reviews, owners: [OWNER, 'other-owner'] })).line).toBe(
      'the owner approved: @other-owner on GitHub',
    );
  });

  it('needs a submitted time it can read', () => {
    expect(ownerApproval(facts({ reviews: [review({ submittedAt: undefined })] })).approved).toBe(
      false,
    );
    expect(ownerApproval(facts({ reviews: [review({ submittedAt: 'soon' })] })).approved).toBe(
      false,
    );
  });
});

describe('the owner approving by authorship', () => {
  const authored = (overrides: Partial<ApprovalFacts> = {}): ApprovalFacts =>
    facts({
      author: OWNER,
      commits: [signed(), signed({ sha: 's2' })],
      commitCount: 2,
      ...overrides,
    });

  it('counts a PR the owner opened with every commit signed by them', () => {
    expect(ownerApproval(authored())).toEqual({
      approved: true,
      line: 'the owner approved: @SvenPGH wrote and signed every commit',
    });
  });

  it.each([
    ['an unverified commit', { verified: false }],
    ['a commit authored by someone else', { author: THEA }],
    ['a commit committed by someone else', { committer: 'web-flow' }],
    ['a commit with no linked author', { author: undefined }],
  ])('refuses %s', (_name, change) => {
    const commits = [signed(), signed({ sha: 's2', ...change })];
    expect(ownerApproval(authored({ commits })).approved).toBe(false);
  });

  it('refuses a PR someone else opened, even with the owner signing every commit', () => {
    expect(ownerApproval(authored({ author: THEA })).approved).toBe(false);
  });

  it('refuses when GitHub listed fewer commits than the PR has', () => {
    expect(ownerApproval(authored({ commitCount: 251 })).approved).toBe(false);
  });

  it('refuses a PR with no commits', () => {
    expect(ownerApproval(authored({ commits: [], commitCount: 0 })).approved).toBe(false);
  });
});

describe("the owner approving through Thea's card", () => {
  it('counts a talos-approve COMMENT from her App on the head after the last push', () => {
    expect(ownerApproval(facts({ reviews: [card()] }))).toEqual({
      approved: true,
      line: 'the owner approved: card card-7 through Thea',
    });
  });

  it('allows surrounding whitespace, nothing more', () => {
    expect(
      ownerApproval(facts({ reviews: [card({ body: `\ntalos-approve card-7 ${HEAD}\n` })] }))
        .approved,
    ).toBe(true);
  });

  const forgeries: [string, Partial<Review>, Partial<ApprovalFacts>?][] = [
    ['from another account', { author: 'mallory' }],
    ['from another App', { author: 'talos-reviewer[bot]' }],
    ['as an APPROVE rather than a COMMENT', { state: 'APPROVED' }],
    ['naming another sha', { body: `talos-approve card-7 ${OLD}` }],
    ['pinned to another commit', { commitId: OLD }],
    ['with no card id', { body: `talos-approve  ${HEAD}` }],
    ['with extra words', { body: `talos-approve card-7 ${HEAD} please` }],
    ['with text before it', { body: `ok talos-approve card-7 ${HEAD}` }],
    ['with a short sha', { body: `talos-approve card-7 ${HEAD.slice(0, 12)}` }],
    ['in another case', { body: `TALOS-APPROVE card-7 ${HEAD}` }],
    ['submitted before the last push', {}, { lastPushAt: '2026-10-23T10:30:00Z' }],
  ];

  it.each(forgeries)('refuses one %s', (_name, change, more = {}) => {
    expect(ownerApproval(facts({ reviews: [card(change)], ...more })).approved).toBe(false);
  });

  it("doesn't count on a protected path or in the Talos repository, and says so", () => {
    expect(ownerApproval(facts({ reviews: [card()], theaCounts: false }))).toEqual({
      approved: false,
      line: "the owner's card doesn't count here: they approve on GitHub",
    });
  });

  it('still counts the owner on GitHub where a card cannot', () => {
    expect(ownerApproval(facts({ reviews: [card(), review()], theaCounts: false })).approved).toBe(
      true,
    );
  });

  it('finds a valid card among older ones', () => {
    const stale = card({ body: `talos-approve card-1 ${OLD}`, commitId: OLD });
    expect(ownerApproval(facts({ reviews: [stale, card()] })).line).toBe(
      'the owner approved: card card-7 through Thea',
    );
  });

  it('reads the card id', () => {
    expect(theaCard(card({ body: `talos-approve 0193-abc ${HEAD}` }), facts())).toBe('0193-abc');
    expect(theaCard(card({ author: 'mallory' }), facts())).toBeUndefined();
  });
});

describe('current', () => {
  it('needs the head, and a time after the last push', () => {
    expect(current(review(), HEAD, undefined)).toBe(true);
    expect(current(review(), OLD, undefined)).toBe(false);
    expect(current(review(), HEAD, '2026-10-23T09:59:59Z')).toBe(true);
    expect(current(review(), HEAD, '2026-10-23T10:00:01Z')).toBe(false);
    expect(current(review(), HEAD, 'not a time')).toBe(false);
  });
});
