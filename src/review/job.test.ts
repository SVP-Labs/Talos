import { describe, expect, it } from 'vitest';
import { defaultReviewDeps, pullOfQueueRef, reviewJob, reviewJobWith, routeEvent } from './job.js';
import { app, BASE, type FakePrGitHub, HEAD, person } from './test/fake.js';
import {
  APPROVE,
  debtScenario,
  deps,
  fakeModel,
  ISSUE,
  jobContext,
  OWNER,
  PR,
  pullPayload,
  REVIEWER,
  reviewPayload,
  THEA,
} from './test/scenario.js';
import { ConfigError } from '../config/load.js';
import { github, GitHubError } from '../github/api.js';
import { identities } from '../github/identities.js';

const WHO = identities({});
const GROUP_SHA = 'd'.repeat(40);

function checkRuns(fake: FakePrGitHub): Record<string, unknown>[] {
  return fake.bodies('POST', 'repos/o/r/check-runs');
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

function lastCheck(fake: FakePrGitHub): Record<string, unknown> {
  const runs = checkRuns(fake);
  expect(runs).not.toHaveLength(0);
  return runs.at(-1) ?? {};
}

function output(check: Record<string, unknown>): { title: string; summary: string; text?: string } {
  const value = check.output;
  if (typeof value !== 'object' || value === null) throw new Error('no output');
  const title = 'title' in value && typeof value.title === 'string' ? value.title : '';
  const summary = 'summary' in value && typeof value.summary === 'string' ? value.summary : '';
  const text = 'text' in value && typeof value.text === 'string' ? value.text : undefined;
  return { title, summary, ...(text === undefined ? {} : { text }) };
}

function submitted(fake: FakePrGitHub): Record<string, unknown>[] {
  return fake.bodies('POST', `repos/o/r/pulls/${PR}/reviews`);
}

describe('reviewJob on a pull request', () => {
  it('reviews the head, approves, and passes debt work without the owner', async () => {
    const fake = debtScenario();
    const model = fakeModel(APPROVE);
    const ctx = jobContext(fake);
    const outcomes = await reviewJobWith(ctx, deps(model));
    expect(outcomes).toEqual([
      { job: 'reviewer', result: 'done', detail: 'approved the head' },
      { job: 'review', result: 'done', detail: `talos/review pass on #${PR}` },
    ]);
    expect(model.prompts).toHaveLength(1);
    expect(submitted(fake)).toEqual([
      {
        commit_id: HEAD,
        event: 'APPROVE',
        body: 'talos-review/1 verdict=APPROVE round=1 findings=0\n\nThe constant is named and tested.',
        comments: [],
      },
    ]);
    const check = lastCheck(fake);
    expect(check).toMatchObject({ name: 'talos/review', head_sha: HEAD, conclusion: 'success' });
    expect(output(check).title).toBe('Passes as debt or chore work, without the owner');
    expect(output(check).summary).toContain('- [x] the reviewer approved the head (round 1)');
    expect(output(check).summary).toContain('- [ ] the owner has not approved the head');
    expect(ctx.configRefs).toEqual(['main']);
    expect(fake.calls.every((c) => c.login === REVIEWER)).toBe(true);
  });

  it('gives the model the issue, the PR, the diff and the files, and CLAUDE.md from the base', async () => {
    const fake = debtScenario();
    const model = fakeModel(APPROVE);
    await reviewJobWith(jobContext(fake), deps(model));
    const [prompt] = model.prompts;
    expect(prompt?.system).toContain('Keep functions small.');
    expect(prompt?.system).toContain('# ENGINEERING');
    expect(prompt?.user).toContain(`## The issue it closes: #${ISSUE}`);
    expect(prompt?.user).toContain('- `src/a/util.ts`');
    expect(prompt?.user).toContain('+export const a = 2;');
    expect(prompt?.user).toContain('### src/a/util.ts');
    expect(fake.calls.some((c) => c.path.startsWith(`repos/o/r/contents/CLAUDE.md?ref=main`))).toBe(
      true,
    );
  });

  it('requests changes with inline comments where the diff shows the line', async () => {
    const fake = debtScenario();
    const model = fakeModel({
      ok: true,
      answer: {
        verdict: 'REQUEST_CHANGES',
        summary: 'Two problems.',
        comments: [
          { path: 'src/a/util.ts', line: 2, body: 'Name it after what it means, @SvenPGH agrees.' },
          { path: 'src/a/util.ts', line: 40, body: 'Outside the diff.' },
        ],
      },
    });
    const outcomes = await reviewJobWith(jobContext(fake), deps(model));
    expect(outcomes[0]).toEqual({
      job: 'reviewer',
      result: 'done',
      detail: 'changes_requested the head',
    });
    const [review] = submitted(fake);
    expect(review).toMatchObject({ event: 'REQUEST_CHANGES', commit_id: HEAD });
    expect(review?.comments).toEqual([
      {
        path: 'src/a/util.ts',
        line: 2,
        side: 'RIGHT',
        body: 'Name it after what it means, @​SvenPGH agrees.',
      },
    ]);
    expect(String(review?.body)).toBe(
      [
        'talos-review/1 verdict=REQUEST_CHANGES round=1 findings=2',
        '',
        'Two problems.',
        '',
        '- `src/a/util.ts:2` Name it after what it means, @​SvenPGH agrees.',
        '- `src/a/util.ts:40` Outside the diff.',
      ].join('\n'),
    );
    const check = lastCheck(fake);
    expect(check.conclusion).toBe('failure');
    expect(output(check).title).toBe('Fails: the reviewer requested changes (round 1, 2 findings)');
  });

  it('counts the round from its earlier requests', async () => {
    const fake = debtScenario();
    fake.reviews.set(PR, [
      {
        user: app(REVIEWER),
        state: 'CHANGES_REQUESTED',
        commit_id: 'c'.repeat(40),
        submitted_at: '2026-10-22T10:00:00Z',
        body: 'talos-review/1 verdict=REQUEST_CHANGES round=1 findings=1\n\nx',
      },
    ]);
    await reviewJobWith(jobContext(fake), deps(fakeModel(APPROVE)));
    expect(String(submitted(fake)[0]?.body)).toMatch(
      /^talos-review\/1 verdict=APPROVE round=2 findings=0\n/,
    );
  });

  it('labels the issue needs-human instead of a third request, and submits nothing', async () => {
    const fake = debtScenario();
    const earlier = (round: number, sha: string) => ({
      user: app(REVIEWER),
      state: round === 1 ? 'DISMISSED' : 'CHANGES_REQUESTED',
      commit_id: sha,
      submitted_at: `2026-10-2${round}T10:00:00Z`,
      body: `talos-review/1 verdict=REQUEST_CHANGES round=${round} findings=1\n\nx`,
    });
    fake.reviews.set(PR, [earlier(1, 'c'.repeat(40)), earlier(2, 'e'.repeat(40))]);
    const model = fakeModel({
      ok: true,
      answer: {
        verdict: 'REQUEST_CHANGES',
        summary: 'Still wrong.',
        comments: [{ path: 'src/a/util.ts', line: 2, body: 'Again.' }],
      },
    });
    const outcomes = await reviewJobWith(jobContext(fake), deps(model));
    expect(outcomes[0]).toEqual({
      job: 'reviewer',
      result: 'done',
      detail: 'two rounds already: labelled needs-human',
    });
    expect(submitted(fake)).toEqual([]);
    expect(fake.bodies('POST', `repos/o/r/issues/${ISSUE}/labels`)).toEqual([
      { labels: ['needs-human'] },
    ]);
    const check = lastCheck(fake);
    expect(check.conclusion).toBe('failure');
    expect(output(check).title).toBe(
      'Fails: the reviewer requested changes twice already: needs a person',
    );
    expect(output(check).text).toContain(
      'talos-review/1 verdict=REQUEST_CHANGES round=3 findings=1',
    );
    expect(output(check).text).toContain('- `src/a/util.ts:2` Again.');
  });

  it('asks no model once the work waits for a person', async () => {
    const fake = debtScenario();
    fake.issues.get(ISSUE)?.labels.push('needs-human');
    const model = fakeModel(APPROVE);
    await reviewJobWith(jobContext(fake), deps(model));
    expect(model.prompts).toEqual([]);
    expect(output(lastCheck(fake)).title).toBe(
      'Fails: the reviewer requested changes twice already: needs a person',
    );
  });

  it('reviews a head once', async () => {
    const fake = debtScenario();
    fake.reviews.set(PR, [
      {
        user: app(REVIEWER),
        state: 'APPROVED',
        commit_id: HEAD,
        submitted_at: '2026-10-23T11:00:00Z',
        body: 'talos-review/1 verdict=APPROVE round=1 findings=0\n\nok',
      },
    ]);
    const model = fakeModel(APPROVE);
    const outcomes = await reviewJobWith(
      jobContext(fake, { payload: pullPayload('edited') }),
      deps(model),
    );
    expect(model.prompts).toEqual([]);
    expect(outcomes[0]).toEqual({
      job: 'reviewer',
      result: 'skipped',
      detail: 'it already reviewed the head',
    });
    expect(lastCheck(fake).conclusion).toBe('success');
  });

  it('waits on a draft without asking the model', async () => {
    const fake = debtScenario();
    const pull = fake.pulls.get(PR);
    if (pull !== undefined) pull.draft = true;
    const model = fakeModel(APPROVE);
    await reviewJobWith(jobContext(fake), deps(model));
    expect(model.prompts).toEqual([]);
    const check = lastCheck(fake);
    expect(check.status).toBe('in_progress');
    expect(check.conclusion).toBeUndefined();
    expect(output(check).title).toBe(
      'Waits: the reviewer waits: the PR is a draft; the review starts when it is ready',
    );
  });

  it('skips the AI review where agents are off, and still decides', async () => {
    const fake = debtScenario();
    fake.properties = { talos: 'stable', 'talos-agents': 'false' };
    const model = fakeModel(APPROVE);
    const outcomes = await reviewJobWith(jobContext(fake), deps(model));
    expect(model.prompts).toEqual([]);
    expect(outcomes[0]).toEqual({
      job: 'reviewer',
      result: 'skipped',
      detail: 'agents are off here',
    });
    expect(lastCheck(fake).conclusion).toBe('success');
  });

  it("never asks the model about a stranger's PR", async () => {
    const fake = debtScenario();
    const pull = fake.pulls.get(PR);
    if (pull !== undefined) pull.user = person('stranger');
    const model = fakeModel(APPROVE);
    await reviewJobWith(jobContext(fake), deps(model));
    expect(model.prompts).toEqual([]);
    expect(output(lastCheck(fake)).title).toBe(
      "Waits: the reviewer waits: the PR's author is not a member or collaborator",
    );
  });

  it('asks to split a PR too large to review, without the model', async () => {
    const fake = debtScenario();
    const pull = fake.pulls.get(PR);
    if (pull !== undefined) pull.changed_files = 150;
    const model = fakeModel(APPROVE);
    await reviewJobWith(jobContext(fake), deps(model));
    expect(model.prompts).toEqual([]);
    expect(String(submitted(fake)[0]?.body)).toBe(
      [
        'talos-review/1 verdict=REQUEST_CHANGES round=1 findings=1',
        '',
        'This PR is too large to review.',
        '',
        '- It changes 150 files; the reviewer reads at most 100. Split it into smaller PRs, each closing its own issue.',
      ].join('\n'),
    );
  });

  it('fails with no verdict when the answer is unreadable, and never approves', async () => {
    const fake = debtScenario();
    const outcomes = await reviewJobWith(
      jobContext(fake),
      deps(fakeModel({ ok: false, reason: 'the answer holds no JSON object' })),
    );
    expect(outcomes[0]).toEqual({
      job: 'reviewer',
      result: 'failed',
      detail: 'no verdict: the answer holds no JSON object',
    });
    expect(submitted(fake)).toEqual([]);
    const check = lastCheck(fake);
    expect(check.conclusion).toBe('failure');
    expect(output(check).title).toBe(
      'Fails: the reviewer gave no verdict: the answer holds no JSON object',
    );
  });

  it('turns a model run that throws into no verdict', async () => {
    const fake = debtScenario();
    const model = { review: () => Promise.reject(new Error('spawn npx ENOENT')) };
    const outcomes = await reviewJobWith(jobContext(fake), deps(model));
    expect(outcomes[0]).toEqual({
      job: 'reviewer',
      result: 'failed',
      detail: 'no verdict: the model run did not finish',
    });
  });

  it('submits without inline comments when GitHub refuses them', async () => {
    const fake = debtScenario();
    let refused = false;
    const refusing: typeof fetch = (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (!refused && urlOf(input).endsWith(`/pulls/${PR}/reviews`) && body.includes('"side"')) {
        refused = true;
        return Promise.resolve(new Response('{"message":"Unprocessable"}', { status: 422 }));
      }
      return fake.fetch(input, init);
    };
    const model = fakeModel({
      ok: true,
      answer: {
        verdict: 'REQUEST_CHANGES',
        summary: 'x',
        comments: [{ path: 'src/a/util.ts', line: 2, body: 'y' }],
      },
    });
    await reviewJobWith(
      jobContext(fake, { gh: github(REVIEWER, { fetch: refusing }) }),
      deps(model),
    );
    expect(refused).toBe(true);
    expect(submitted(fake).map((r) => r.comments)).toEqual([[]]);
  });

  it('lets any other refusal of the review fail the job', async () => {
    const fake = debtScenario();
    fake.failures.set(`POST repos/o/r/pulls/${PR}/reviews`, 403);
    await expect(reviewJobWith(jobContext(fake), deps(fakeModel(APPROVE)))).rejects.toBeInstanceOf(
      GitHubError,
    );
    expect(output(lastCheck(fake)).title).toBe('Could not decide');
  });

  it("waits for the owner on a feature, and passes on the owner's APPROVE of the head", async () => {
    const fake = debtScenario();
    const issue = fake.issues.get(ISSUE);
    if (issue !== undefined) issue.labels = ['feature'];
    await reviewJobWith(jobContext(fake), deps(fakeModel(APPROVE)));
    const waiting = lastCheck(fake);
    expect(waiting.status).toBe('in_progress');
    expect(output(waiting).title).toBe("Waits for the owner's approval");
    expect(output(waiting).summary).toContain('- [ ] #12 is feature, not chore or debt work');
    fake.reviews.get(PR)?.push({
      user: person(OWNER),
      state: 'APPROVED',
      commit_id: HEAD,
      submitted_at: '2026-10-23T12:30:00Z',
      body: '',
    });
    const ctx = jobContext(fake, {
      event: 'pull_request_review',
      payload: reviewPayload(OWNER, 'OWNER'),
    });
    await reviewJobWith(ctx, deps(fakeModel(APPROVE)));
    expect(lastCheck(fake)).toMatchObject({ conclusion: 'success' });
    expect(output(lastCheck(fake)).summary).toContain(
      '- [x] the owner approved: @SvenPGH on GitHub',
    );
  });

  it("voids the owner's approval with a later force-push", async () => {
    const fake = debtScenario();
    const issue = fake.issues.get(ISSUE);
    if (issue !== undefined) issue.labels = ['feature'];
    fake.reviews.set(PR, [
      {
        user: app(REVIEWER),
        state: 'APPROVED',
        commit_id: HEAD,
        submitted_at: '2026-10-23T09:00:00Z',
        body: 'talos-review/1 verdict=APPROVE round=1 findings=0\n\nok',
      },
      {
        user: person(OWNER),
        state: 'APPROVED',
        commit_id: HEAD,
        submitted_at: '2026-10-23T10:00:00Z',
        body: '',
      },
    ]);
    fake.pullEvents.set(PR, [
      { event: 'head_ref_force_pushed', actor: app(THEA), created_at: '2026-10-23T11:00:00Z' },
    ]);
    await reviewJobWith(jobContext(fake), deps(fakeModel(APPROVE)));
    expect(output(lastCheck(fake)).title).toBe("Waits for the owner's approval");
  });

  it("passes on Thea's talos-approve card, except on a protected path", async () => {
    const card = {
      user: app(THEA),
      state: 'COMMENTED',
      commit_id: HEAD,
      submitted_at: '2026-10-23T12:30:00Z',
      body: `talos-approve card-9 ${HEAD}`,
    };
    const fake = debtScenario();
    const issue = fake.issues.get(ISSUE);
    if (issue !== undefined) issue.labels = ['feature'];
    fake.reviews.set(PR, [card]);
    const ctx = jobContext(fake, {
      event: 'pull_request_review',
      payload: reviewPayload(THEA, 'NONE', 'commented'),
    });
    await reviewJobWith(ctx, deps(fakeModel(APPROVE)));
    expect(lastCheck(fake).conclusion).toBe('success');
    expect(output(lastCheck(fake)).summary).toContain(
      '- [x] the owner approved: card card-9 through Thea',
    );

    const risky = debtScenario();
    risky.files.get(PR)?.push({
      filename: 'src/risk/rules.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: UTIL_LIKE,
    });
    risky.reviews.set(PR, [card]);
    await reviewJobWith(
      jobContext(risky, { event: 'pull_request_review', payload: reviewPayload(THEA, 'NONE') }),
      deps(fakeModel(APPROVE)),
    );
    expect(output(lastCheck(risky)).title).toBe("Waits for the owner's approval");
    expect(output(lastCheck(risky)).summary).toContain(
      "- [ ] the owner's card doesn't count here: they approve on GitHub",
    );
    expect(output(lastCheck(risky)).summary).toContain(
      '- [ ] touches protected paths: src/risk/rules.ts',
    );
  });

  it('needs the owner for every PR in the Talos repository', async () => {
    const fake = debtScenario();
    await reviewJobWith(
      jobContext(fake, { who: { ...WHO, talosRepo: 'o/r' } }),
      deps(fakeModel(APPROVE)),
    );
    expect(output(lastCheck(fake)).summary).toContain(
      '- [ ] the Talos repository: every PR needs the owner',
    );
    expect(lastCheck(fake).status).toBe('in_progress');
  });

  it('fails a PR whose branch is no ticket, whatever else holds', async () => {
    const fake = debtScenario();
    const pull = fake.pulls.get(PR);
    if (pull !== undefined) pull.head.ref = 'thea/fix';
    await reviewJobWith(jobContext(fake), deps(fakeModel(APPROVE)));
    expect(lastCheck(fake).conclusion).toBe('failure');
    expect(output(lastCheck(fake)).title).toBe(
      'Fails: branch thea/fix is not a ticket branch T-<N>',
    );
  });

  it('skips a closed PR without a check', async () => {
    const fake = debtScenario();
    const pull = fake.pulls.get(PR);
    if (pull !== undefined) pull.state = 'closed';
    expect(await reviewJobWith(jobContext(fake), deps(fakeModel(APPROVE)))).toEqual([
      { job: 'review', result: 'skipped', detail: 'the PR is closed' },
    ]);
    expect(checkRuns(fake)).toEqual([]);
  });

  it("publishes a red check when it can't read the PR, and rethrows", async () => {
    const fake = debtScenario();
    fake.failures.set(`GET repos/o/r/pulls/${PR}`, 502);
    await expect(reviewJobWith(jobContext(fake), deps(fakeModel(APPROVE)))).rejects.toBeInstanceOf(
      GitHubError,
    );
    const check = lastCheck(fake);
    expect(check).toMatchObject({ name: 'talos/review', head_sha: HEAD, conclusion: 'failure' });
    expect(output(check).title).toBe('Could not decide');
    expect(output(check).summary).toBe(
      `GitHub refused a request: GET repos/o/r/pulls/${PR}: 502\n\nIt decides again on the next push, review or re-run.`,
    );
  });
});

describe('reviewJob on a merge group', () => {
  const groupPayload = (action = 'checks_requested') => ({
    action,
    merge_group: {
      head_sha: GROUP_SHA,
      head_ref: `refs/heads/gh-readonly-queue/main/pr-${PR}-${BASE}`,
      base_sha: BASE,
      base_ref: 'refs/heads/main',
    },
    repository: { full_name: 'o/r', default_branch: 'main' },
  });

  it("recomputes for the PR and posts on the group's head, reading talos.yml there", async () => {
    const fake = debtScenario();
    fake.reviews.set(PR, [
      {
        user: app(REVIEWER),
        state: 'APPROVED',
        commit_id: HEAD,
        submitted_at: '2026-10-23T11:00:00Z',
        body: 'talos-review/1 verdict=APPROVE round=1 findings=0\n\nok',
      },
    ]);
    fake.contents.set(`${BASE}:.github/CODEOWNERS`, `* @${OWNER}\n`);
    const model = fakeModel(APPROVE);
    const ctx = jobContext(fake, { event: 'merge_group', payload: groupPayload() });
    const outcomes = await reviewJobWith(ctx, deps(model));
    expect(outcomes).toEqual([
      { job: 'review', result: 'done', detail: `talos/review pass on #${PR} in the merge queue` },
    ]);
    expect(model.prompts).toEqual([]);
    expect(ctx.configRefs).toEqual([GROUP_SHA]);
    expect(lastCheck(fake)).toMatchObject({ head_sha: GROUP_SHA, conclusion: 'success' });
    expect(
      fake.calls.some((c) => c.path === `repos/o/r/contents/.github/CODEOWNERS?ref=${BASE}`),
    ).toBe(true);
  });

  it('fails rather than waits in the queue', async () => {
    const fake = debtScenario();
    const ctx = jobContext(fake, { event: 'merge_group', payload: groupPayload() });
    await reviewJobWith(ctx, deps(fakeModel(APPROVE)));
    expect(lastCheck(fake)).toMatchObject({ head_sha: GROUP_SHA, conclusion: 'failure' });
    expect(submitted(fake)).toEqual([]);
  });

  it('ignores a destroyed group', async () => {
    const fake = debtScenario();
    const ctx = jobContext(fake, { event: 'merge_group', payload: groupPayload('destroyed') });
    expect(await reviewJobWith(ctx, deps(fakeModel(APPROVE)))).toEqual([
      { job: 'review', result: 'skipped', detail: 'merge_group destroyed' },
    ]);
    expect(fake.calls).toEqual([]);
  });
});

describe('reviewJob refuses', () => {
  it('reviews by strangers and by the reviewer itself, before any call', async () => {
    for (const [login, association, detail] of [
      ['stranger', 'NONE', 'review author not trusted'],
      [REVIEWER, 'NONE', "the reviewer's own review"],
    ] as const) {
      const fake = debtScenario();
      const ctx = jobContext(fake, {
        event: 'pull_request_review',
        payload: reviewPayload(login, association),
      });
      expect(await reviewJobWith(ctx, deps(fakeModel(APPROVE)))).toEqual([
        { job: 'review', result: 'skipped', detail },
      ]);
      expect(fake.calls).toEqual([]);
    }
  });

  it('the analyze phase, and an act phase without the reviewer token', async () => {
    const fake = debtScenario();
    expect(
      await reviewJobWith(jobContext(fake, { phase: 'analyze' }), deps(fakeModel(APPROVE))),
    ).toEqual([{ job: 'review', result: 'skipped', detail: 'runs in the act phase' }]);
    const { gh: _gh, ...withoutToken } = jobContext(fake);
    expect(await reviewJobWith(withoutToken, deps(fakeModel(APPROVE)))).toEqual([
      { job: 'review', result: 'failed', detail: 'no reviewer token' },
    ]);
    expect(fake.calls).toEqual([]);
  });
});

describe('routeEvent', () => {
  it('reviews the PR actions that change what it judges', () => {
    for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited']) {
      expect(routeEvent('pull_request_target', pullPayload(action), WHO)).toEqual({
        target: { pr: PR, sha: HEAD, group: undefined },
      });
    }
    expect(routeEvent('pull_request_target', pullPayload('labeled'), WHO)).toEqual({
      skip: 'pull_request_target labeled',
    });
  });

  it('admits reviews from the owner, members, collaborators and Thea', () => {
    for (const [login, association] of [
      [OWNER, 'OWNER'],
      ['member', 'MEMBER'],
      ['helper', 'COLLABORATOR'],
      [THEA, 'NONE'],
    ] as const) {
      expect(
        routeEvent('pull_request_review', reviewPayload(login, association), WHO),
      ).toHaveProperty('target');
    }
  });

  it('skips unreadable payloads and other events', () => {
    expect(routeEvent('pull_request_target', {}, WHO)).toEqual({
      skip: 'unreadable pull_request_target payload',
    });
    expect(routeEvent('pull_request_review', { action: 'submitted' }, WHO)).toEqual({
      skip: 'unreadable pull_request_review payload',
    });
    expect(routeEvent('merge_group', { merge_group: {} }, WHO)).toEqual({
      skip: 'unreadable merge_group payload',
    });
    expect(routeEvent('issues', {}, WHO)).toEqual({ skip: 'no review on issues' });
  });

  it('skips a merge group whose branch names no PR', () => {
    const payload = {
      action: 'checks_requested',
      merge_group: { head_sha: GROUP_SHA, head_ref: 'refs/heads/main', base_sha: BASE },
    };
    expect(routeEvent('merge_group', payload, WHO)).toEqual({
      skip: 'the merge group names no PR',
    });
  });
});

describe('pullOfQueueRef', () => {
  it("reads the PR from the queue's branch, whatever the base is called", () => {
    expect(pullOfQueueRef(`refs/heads/gh-readonly-queue/main/pr-20-${BASE}`)).toBe(20);
    expect(pullOfQueueRef(`gh-readonly-queue/release/2.x/pr-7-${BASE}`)).toBe(7);
    expect(
      pullOfQueueRef(`refs/heads/gh-readonly-queue/main/pr-20-${BASE.slice(0, 7)}`),
    ).toBeUndefined();
    expect(pullOfQueueRef(`refs/heads/feature/pr-20-${BASE}`)).toBeUndefined();
    expect(pullOfQueueRef(`refs/heads/gh-readonly-queue/main/pr-0-${BASE}`)).toBeUndefined();
  });
});

const UTIL_LIKE = '@@ -1 +1 @@\n-const x = 1;\n+const x = 2;';

describe('reviewJob as shipped', () => {
  it('reads the rubric from the assets and the guard list from the packs', async () => {
    const shipped = defaultReviewDeps({});
    expect(await shipped.rubric()).toContain('# Review a pull request');
    expect(await shipped.engineering()).toContain('# Engineering standard');
    expect(shipped.extensions).toEqual(
      expect.arrayContaining(['eslint.project.js', 'tsconfig.json']),
    );
  });

  it('keeps the signature the dispatcher calls', async () => {
    expect(await reviewJob(jobContext(debtScenario(), { phase: 'analyze' }))).toEqual([
      { job: 'review', result: 'skipped', detail: 'runs in the act phase' },
    ]);
  });
});

describe('when talos/review cannot decide', () => {
  it.each([
    ['an invalid talos.yml', new ConfigError('prefix: must be capitals'), 'talos.yml is invalid'],
    ['an unexpected error', new TypeError('x is undefined'), 'TypeError while reading the PR'],
    ['a thrown value', { reason: 'boom' }, 'an error while reading the PR'],
  ])('says so for %s, without its message', async (_name, error, detail) => {
    const fake = debtScenario();
    const thrown: unknown = error;
    const ctx = jobContext(fake, {
      config: async () => {
        await Promise.resolve();
        throw thrown;
      },
    });
    await expect(reviewJobWith(ctx, deps(fakeModel(APPROVE)))).rejects.toBe(error);
    expect(output(lastCheck(fake)).summary.split('\n')[0]).toBe(detail);
  });

  it('says so for a response of the wrong shape', async () => {
    const fake = debtScenario();
    const odd: typeof fetch = (input, init) =>
      urlOf(input).endsWith(`/pulls/${PR}`)
        ? Promise.resolve(
            new Response('{"number":"twenty"}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
        : fake.fetch(input, init);
    const ctx = jobContext(fake, { gh: github(REVIEWER, { fetch: odd }) });
    await expect(reviewJobWith(ctx, deps(fakeModel(APPROVE)))).rejects.toThrow();
    expect(output(lastCheck(fake)).summary.split('\n')[0]).toBe(
      'a response from GitHub had an unexpected shape',
    );
  });

  it('never reads unreadable agent settings as off', async () => {
    const fake = debtScenario();
    fake.failures.set('GET repos/o/r/properties/values', 403);
    const model = fakeModel(APPROVE);
    await expect(reviewJobWith(jobContext(fake), deps(model))).rejects.toMatchObject({
      status: 403,
    });
    expect(model.prompts).toEqual([]);
    expect(lastCheck(fake).conclusion).toBe('failure');
  });

  it('still rethrows when even the red check fails', async () => {
    const fake = debtScenario();
    fake.failures.set(`GET repos/o/r/pulls/${PR}`, 502);
    fake.failures.set('POST repos/o/r/check-runs', 403);
    await expect(reviewJobWith(jobContext(fake), deps(fakeModel(APPROVE)))).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe('reviewJob without a single debt issue', () => {
  it('fails a PR that closes no issue, and holds every file outside a scope', async () => {
    const fake = debtScenario();
    fake.closing.set(PR, []);
    await reviewJobWith(jobContext(fake), deps(fakeModel(APPROVE)));
    const { title, summary } = output(lastCheck(fake));
    expect(title).toBe('Fails: branch T-12 closes no issue; it must close #12 only');
    expect(summary).toContain('- [ ] closes 0 issues; debt and chore work closes exactly one');
    expect(summary).toContain(
      '- [ ] touches files its issue does not name: src/a/util.ts, src/a/util.test.ts',
    );
  });

  it('holds an issue with two type labels to the owner', async () => {
    const fake = debtScenario();
    const issue = fake.issues.get(ISSUE);
    if (issue !== undefined) issue.labels = ['chore', 'feature'];
    await reviewJobWith(jobContext(fake), deps(fakeModel(APPROVE)));
    expect(output(lastCheck(fake)).summary).toContain(
      '- [ ] no record of who labelled #12 no single type',
    );
  });

  it('stops at a needs-human label on the PR itself', async () => {
    const fake = debtScenario();
    fake.pulls.get(PR)?.labels.push('needs-human');
    const model = fakeModel(APPROVE);
    await reviewJobWith(jobContext(fake), deps(model));
    expect(model.prompts).toEqual([]);
    expect(lastCheck(fake).conclusion).toBe('failure');
  });

  it('labels the PR when a third request has no issue to label', async () => {
    const fake = debtScenario();
    fake.closing.set(PR, []);
    const earlier = (round: number) => ({
      user: app(REVIEWER),
      state: 'CHANGES_REQUESTED',
      commit_id: `${round}`.repeat(40),
      submitted_at: `2026-10-2${round}T10:00:00Z`,
      body: `talos-review/1 verdict=REQUEST_CHANGES round=${round} findings=1`,
    });
    fake.reviews.set(PR, [earlier(1), earlier(2)]);
    fake.issues.set(PR, { number: PR, title: 'the PR', body: '', labels: [], events: [] });
    const model = fakeModel({
      ok: true,
      answer: { verdict: 'REQUEST_CHANGES', summary: 'x', comments: [] },
    });
    await reviewJobWith(jobContext(fake), deps(model));
    expect(fake.bodies('POST', `repos/o/r/issues/${PR}/labels`)).toEqual([
      { labels: ['needs-human'] },
    ]);
  });
});
