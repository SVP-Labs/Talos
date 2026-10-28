import { describe, expect, it } from 'vitest';
import { decide } from './conditions.js';
import { closingIssues, lastMove, repoProperties } from './github.js';
import { checkFields, checkSummary, errorFields, reviewerOutcome } from './report.js';
import {
  diffLines,
  inlineComments,
  notToReview,
  type ReviewerFacts,
  reviewerState,
  type ReviewerRun,
  requestedRounds,
  reviewOfHead,
  waitsForPerson,
} from './reviewer.js';
import { HEAD } from './test/fake.js';
import type { IssueEvent, Pull, PullFile, Review } from './types.js';
import { github } from '../github/api.js';
import { identities } from '../github/identities.js';

const WHO = identities({});
const REVIEWER = WHO.reviewer;
const OLD = 'c'.repeat(40);

function review(overrides: Partial<Review> = {}): Review {
  return {
    author: REVIEWER,
    state: 'APPROVED',
    commitId: HEAD,
    submittedAt: '2026-10-23T10:00:00Z',
    body: 'talos-review/1 verdict=APPROVE round=1 findings=0\n\nok',
    ...overrides,
  };
}

const changes = (round: number, commitId = OLD, state = 'CHANGES_REQUESTED'): Review =>
  review({
    state,
    commitId,
    body: `talos-review/1 verdict=REQUEST_CHANGES round=${round} findings=2\n\nx`,
  });

function state(reviews: readonly Review[], run?: ReviewerRun, waits = false) {
  return reviewerState({
    agentsOn: true,
    reviews,
    reviewer: REVIEWER,
    head: HEAD,
    run,
    waitsForPerson: waits,
  });
}

describe('reviewerState', () => {
  it('is off where agents are off, whatever was reviewed', () => {
    expect(
      reviewerState({
        agentsOn: false,
        reviews: [changes(1, HEAD)],
        reviewer: REVIEWER,
        head: HEAD,
        run: undefined,
        waitsForPerson: true,
      }),
    ).toEqual({ kind: 'off' });
  });

  it("reads its latest review of the head, with the header's round and findings", () => {
    expect(state([review()])).toEqual({ kind: 'approved', round: 1 });
    expect(
      state([changes(1), review({ body: 'talos-review/1 verdict=APPROVE round=2 findings=0' })]),
    ).toEqual({
      kind: 'approved',
      round: 2,
    });
    expect(state([changes(2, HEAD)])).toEqual({ kind: 'changes', round: 2, findings: 2 });
  });

  it('counts the round for a review without a header', () => {
    expect(state([changes(1), review({ body: '' })])).toEqual({ kind: 'approved', round: 2 });
    expect(state([review({ state: 'CHANGES_REQUESTED', body: '' })])).toEqual({
      kind: 'changes',
      round: 1,
      findings: 0,
    });
  });

  it("ignores others' reviews, reviews of older commits, and pending ones", () => {
    expect(state([review({ author: 'SvenPGH' })])).toEqual({
      kind: 'waiting',
      reason: 'it has not reviewed the head yet',
    });
    expect(state([review({ commitId: OLD })]).kind).toBe('waiting');
    expect(state([review({ state: 'PENDING' })]).kind).toBe('waiting');
  });

  it('takes a dismissed or verdict-less review of the head as no approval', () => {
    expect(state([review({ state: 'DISMISSED' })])).toEqual({
      kind: 'waiting',
      reason: 'its review of the head was dismissed',
    });
    expect(state([review({ state: 'COMMENTED', body: 'note' })])).toEqual({
      kind: 'waiting',
      reason: 'it left no verdict on the head',
    });
  });

  it('follows this run when there is no review of the head', () => {
    expect(state([], { kind: 'needs-human' })).toEqual({ kind: 'needs-human' });
    expect(state([], undefined, true)).toEqual({ kind: 'needs-human' });
    expect(state([], { kind: 'no-verdict', reason: 'x' })).toEqual({
      kind: 'no-verdict',
      reason: 'x',
    });
    expect(state([], { kind: 'skipped', reason: 'the PR is a draft' })).toEqual({
      kind: 'waiting',
      reason: 'the PR is a draft',
    });
  });

  it('lets an approval of the head stand over a needs-human label', () => {
    expect(state([review()], undefined, true)).toEqual({ kind: 'approved', round: 1 });
  });
});

describe('the reviewer by login', () => {
  it('finds its reviews whatever case its login is configured in', () => {
    const upper = REVIEWER.toUpperCase();
    expect(requestedRounds([changes(1)], upper)).toBe(1);
    expect(reviewOfHead([review()], upper, HEAD)).toBeDefined();
  });
});

describe('requestedRounds', () => {
  it("counts the reviewer's requests on every commit, dismissed ones included", () => {
    expect(
      requestedRounds([changes(1), changes(2, 'e'.repeat(40), 'DISMISSED'), review()], REVIEWER),
    ).toBe(2);
    expect(requestedRounds([review({ state: 'CHANGES_REQUESTED', body: '' })], REVIEWER)).toBe(1);
    expect(requestedRounds([changes(1), { ...changes(1), author: 'SvenPGH' }], REVIEWER)).toBe(1);
    expect(
      requestedRounds(
        [
          review({
            state: 'CHANGES_REQUESTED',
            body: 'talos-review/1 verdict=APPROVE round=1 findings=0',
          }),
        ],
        REVIEWER,
      ),
    ).toBe(0);
    expect(requestedRounds([], REVIEWER)).toBe(0);
  });

  it('finds the latest review of the head', () => {
    const later = review({ submittedAt: '2026-10-23T11:00:00Z', state: 'CHANGES_REQUESTED' });
    expect(reviewOfHead([review(), later], REVIEWER, HEAD)).toBe(later);
    expect(reviewOfHead([review()], REVIEWER, OLD)).toBeUndefined();
  });
});

function pull(overrides: Partial<Pull> = {}): Pull {
  return {
    number: 20,
    state: 'open',
    draft: false,
    title: 't',
    body: '',
    author: WHO.thea,
    association: 'NONE',
    headSha: HEAD,
    headRef: 'T-12',
    baseRef: 'main',
    commits: 1,
    changedFiles: 1,
    labels: [],
    ...overrides,
  };
}

function facts(overrides: Partial<ReviewerFacts> = {}): ReviewerFacts {
  return {
    repo: 'o/r',
    who: WHO,
    agentsOn: true,
    pull: pull(),
    files: [],
    reviews: [],
    issue: undefined,
    ...overrides,
  };
}

const ISSUE = {
  number: 12,
  title: 't',
  body: '',
  state: 'open' as const,
  stateReason: undefined,
  labels: ['chore'],
  author: 'SvenPGH',
  association: 'OWNER',
  createdAt: '2026-10-01T00:00:00Z',
  closedAt: undefined,
  isPull: false,
};

describe('notToReview', () => {
  it('reviews an open, ready PR from a trusted author once per head', () => {
    expect(notToReview(facts())).toBeUndefined();
    expect(
      notToReview(facts({ pull: pull({ author: 'dependabot[bot]', association: 'NONE' }) })),
    ).toBeUndefined();
    expect(
      notToReview(facts({ pull: pull({ author: 'helper', association: 'COLLABORATOR' }) })),
    ).toBeUndefined();
  });

  it.each([
    ['agents are off', { agentsOn: false }, 'agents are off here'],
    ['a closed PR', { pull: pull({ state: 'closed' }) }, 'the PR is closed'],
    [
      'a draft',
      { pull: pull({ draft: true }) },
      'the PR is a draft; the review starts when it is ready',
    ],
    ['a reviewed head', { reviews: [review()] }, 'it already reviewed the head'],
    [
      'a stranger',
      { pull: pull({ author: 'stranger', association: 'CONTRIBUTOR' }) },
      "the PR's author is not a member or collaborator",
    ],
    [
      'another bot',
      { pull: pull({ author: 'renovate[bot]', association: 'NONE' }) },
      "the PR's author is not a member or collaborator",
    ],
  ])('skips %s', (_name, change, reason) => {
    expect(notToReview(facts(change))).toEqual({ kind: 'skipped', reason });
  });

  it('stops at needs-human on the issue or the PR', () => {
    const labelled = { ...ISSUE, labels: ['chore', 'needs-human'] };
    expect(notToReview(facts({ issue: labelled }))).toEqual({ kind: 'needs-human' });
    expect(notToReview(facts({ pull: pull({ labels: ['needs-human'] }) }))).toEqual({
      kind: 'needs-human',
    });
    expect(waitsForPerson({ pull: pull(), issue: ISSUE })).toBe(false);
  });
});

function changed(path: string, patch: string | undefined, status = 'modified'): PullFile {
  return { path, status, previousPath: undefined, changes: 2, patch };
}

describe('inline comments', () => {
  const files = [
    changed('src/a.ts', '@@ -10,3 +10,4 @@\n a\n-b\n+c\n+d\n e\n@@ -40 +41 @@\n-x\n+y'),
    changed('src/gone.ts', '@@ -1,2 +0,0 @@\n-a\n-b', 'removed'),
    changed('logo.png', undefined),
  ];

  it("knows the lines each file's diff shows on the head's side", () => {
    expect([...diffLines(files)]).toEqual([
      [
        'src/a.ts',
        [
          { start: 10, end: 13 },
          { start: 41, end: 41 },
        ],
      ],
    ]);
  });

  it('keeps findings on a shown line inline, and the rest for the body', () => {
    const findings = [
      { path: 'src/a.ts', line: 10, body: 'first line of the hunk' },
      { path: 'src/a.ts', line: 13, body: 'last line of the hunk' },
      { path: 'src/a.ts', line: 14, body: 'just past it' },
      { path: 'src/a.ts', line: 41, body: 'second hunk' },
      { path: 'src/gone.ts', line: 1, body: 'deleted file' },
      { path: 'src/other.ts', line: 1, body: 'not in the diff' },
      { body: 'the whole PR' },
    ];
    expect(inlineComments(findings, files).map((c) => c.body)).toEqual([
      'first line of the hunk',
      'last line of the hunk',
      'second hunk',
    ]);
  });

  it('clips and defuses what it posts', () => {
    const [comment] = inlineComments(
      [{ path: 'src/a.ts', line: 10, body: `ping @SvenPGH ${'x'.repeat(5000)}` }],
      files,
    );
    expect(comment?.body).toHaveLength(4000);
    expect(comment?.body.startsWith('ping @​SvenPGH')).toBe(true);
  });
});

describe('lastMove', () => {
  const event = (name: string, createdAt: string | undefined): IssueEvent => ({
    event: name,
    label: undefined,
    actor: 'thea-svp[bot]',
    actorType: 'Bot',
    createdAt,
  });

  it('takes the latest force-push or base change', () => {
    expect(
      lastMove([
        event('head_ref_force_pushed', '2026-10-23T09:00:00Z'),
        event('base_ref_changed', '2026-10-23T11:00:00Z'),
        event('head_ref_force_pushed', '2026-10-23T10:00:00Z'),
        event('labeled', '2026-10-23T12:00:00Z'),
        event('head_ref_force_pushed', undefined),
      ]),
    ).toBe('2026-10-23T11:00:00Z');
    expect(lastMove([event('committed', '2026-10-23T09:00:00Z')])).toBeUndefined();
  });
});

describe('closingIssues', () => {
  const answering = (data: unknown) =>
    github('t', {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ data }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });

  it('reads the issues GitHub links, and counts those beyond the first page', async () => {
    const gh = answering({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            totalCount: 12,
            nodes: [{ number: 3, repository: { nameWithOwner: 'o/r' } }, null],
          },
        },
      },
    });
    expect(await closingIssues(gh, 'o/r', 20)).toEqual({
      issues: [{ number: 3, repo: 'o/r' }],
      total: 12,
    });
  });

  it('reads none for a PR it cannot see', async () => {
    expect(await closingIssues(answering({ repository: null }), 'o/r', 20)).toEqual({
      issues: [],
      total: 0,
    });
    expect(
      await closingIssues(answering({ repository: { pullRequest: null } }), 'o/r', 20),
    ).toEqual({
      issues: [],
      total: 0,
    });
  });
});

describe('the check run', () => {
  const decision = decide({
    rules: [{ met: true, line: 'rule' }],
    reviewer: { kind: 'approved', round: 1 },
    owner: { approved: false, line: 'the owner has not approved the head' },
    unattended: {
      closingCount: 1,
      issue: { number: 12, type: 'feature', setter: 'person' },
      outside: [],
      guarded: [],
      integrity: { flagged: false, reasons: [] },
      protectedPaths: [],
      isTalos: false,
      onChannel: true,
    },
  });

  it('lists every condition, the debt and chore ones apart', () => {
    expect(checkSummary(decision).split('\n').slice(0, 6)).toEqual([
      '- [x] rule',
      '- [x] the reviewer approved the head (round 1)',
      '- [ ] the owner has not approved the head',
      '',
      'Without the owner, debt and chore work lands when all of these hold:',
      '',
    ]);
  });

  it('waits in progress, and completes on pass or fail', () => {
    expect(checkFields(decision, 'wait', undefined)).toMatchObject({ status: 'in_progress' });
    expect(checkFields(decision, 'wait', undefined)).not.toHaveProperty('conclusion');
    expect(checkFields(decision, 'pass', undefined)).toMatchObject({ conclusion: 'success' });
    expect(checkFields(decision, 'fail', undefined)).toMatchObject({ conclusion: 'failure' });
    expect(checkFields(decision, 'fail', { kind: 'needs-human' }).output).not.toHaveProperty(
      'text',
    );
  });

  it('says what failed when it could not decide', () => {
    expect(errorFields('talos.yml is invalid')).toEqual({
      conclusion: 'failure',
      output: {
        title: 'Could not decide',
        summary: 'talos.yml is invalid\n\nIt decides again on the next push, review or re-run.',
      },
    });
  });

  it("reports the reviewer's run in one line", () => {
    expect(reviewerOutcome({ kind: 'reviewed', review: review() })).toEqual({
      job: 'reviewer',
      result: 'done',
      detail: 'approved the head',
    });
    expect(reviewerOutcome({ kind: 'skipped', reason: 'agents are off here' })).toEqual({
      job: 'reviewer',
      result: 'skipped',
      detail: 'agents are off here',
    });
  });
});

describe('repoProperties', () => {
  const answering = (values: unknown) =>
    github('t', {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(values), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
  const value = (name: string, v: unknown) => ({ property_name: name, value: v });

  it('reads agents and whether the repository is on a channel', async () => {
    expect(
      await repoProperties(
        answering([value('talos', 'stable'), value('talos-agents', 'true')]),
        'o/r',
      ),
    ).toEqual({ agentsOn: true, onChannel: true });
    expect(await repoProperties(answering([value('talos', 'canary')]), 'o/r')).toEqual({
      agentsOn: false,
      onChannel: true,
    });
  });

  it('reads evaluate, an unset channel and an unknown value as off a channel', async () => {
    for (const talos of ['evaluate', null, 'nightly', ['canary']]) {
      const props = await repoProperties(answering([value('talos', talos)]), 'o/r');
      expect(props.onChannel).toBe(false);
    }
    expect((await repoProperties(answering([]), 'o/r')).onChannel).toBe(false);
  });
});
