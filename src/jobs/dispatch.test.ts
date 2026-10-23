import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AnalyzeDeps } from './analyze.js';
import type { JobContext, JobOutcome } from './context.js';
import { type JobDeps, runJobs } from './dispatch.js';
import { downloader } from '../github/artifacts.js';
import { testContext } from './test/context.js';
import { finding, outcome, reportOf, result } from './test/findings.js';
import { FakeGitHub } from '../ticket/test/fake-github.js';

const MONDAY = new Date('2026-10-26T03:17:00Z');
const TUESDAY = new Date('2026-10-27T03:17:00Z');
const LABELS = [
  { name: 'bug', color: 'D73A4A', description: 'Type: broken.' },
  { name: 'status/ready', color: '0E8A16', description: 'Ready.' },
];

function summary(outcomes: readonly JobOutcome[]): string[] {
  return outcomes.map((o) => `${o.job} ${o.result}: ${o.detail}`);
}

describe('runJobs', () => {
  let fake: FakeGitHub;
  let reviewed: JobContext[];
  let deps: JobDeps;

  beforeEach(() => {
    fake = new FakeGitHub();
    reviewed = [];
    deps = {
      review: (ctx) => {
        reviewed.push(ctx);
        return Promise.resolve([{ job: 'review', result: 'done', detail: 'published' }]);
      },
      labels: () => Promise.resolve(LABELS),
      download: downloader('w', { fetch: fake.fetch }),
    };
  });

  it("stops a stranger's comment or review before any API call", async () => {
    const payload = { comment: { user: { login: 'mallory' }, author_association: 'NONE' } };
    const ctx = await testContext(fake, { event: 'issue_comment', payload });
    expect(summary(await runJobs(ctx, deps))).toEqual(['admission skipped: author not trusted']);
    const review = { review: { user: { login: 'mallory' }, author_association: 'NONE' } };
    const reviewCtx = await testContext(fake, { event: 'pull_request_review', payload: review });
    expect(summary(await runJobs(reviewCtx, deps))).toEqual([
      'admission skipped: author not trusted',
    ]);
    expect(fake.calls).toEqual([]);
    expect(reviewed).toEqual([]);
  });

  it('hands pull requests, merge groups and trusted reviews to the review', async () => {
    for (const event of ['pull_request_target', 'merge_group']) {
      const ctx = await testContext(fake, { event, payload: { any: 'thing' } });
      expect(summary(await runJobs(ctx, deps))).toEqual(['review done: published']);
    }
    const payload = { review: { user: { login: 'thea-svp[bot]' }, author_association: 'NONE' } };
    const ctx = await testContext(fake, { event: 'pull_request_review', payload });
    expect(summary(await runJobs(ctx, deps))).toEqual(['review done: published']);
    expect(reviewed.map((c) => c.event)).toEqual([
      'pull_request_target',
      'merge_group',
      'pull_request_review',
    ]);
  });

  it('reports a review that throws as a failed job', async () => {
    const failing: JobDeps = { ...deps, review: () => Promise.reject(new Error('secret detail')) };
    const ctx = await testContext(fake, { event: 'merge_group' });
    expect(summary(await runJobs(ctx, failing))).toEqual(['review failed: Error in the job']);
  });

  it('runs nothing for these events in the analyze phase', async () => {
    const ctx = await testContext(fake, { event: 'pull_request_target', phase: 'analyze' });
    expect(summary(await runJobs(ctx, deps))).toEqual([
      'analyze skipped: nothing to analyze on pull_request_target',
    ]);
    expect(reviewed).toEqual([]);
  });

  it('judges readiness on issue events', async () => {
    fake.addIssue({ number: 3, body: '', labels: ['bug'] });
    const payload = {
      action: 'opened',
      issue: { number: 3, user: { login: 'SvenPGH' }, author_association: 'OWNER' },
    };
    const ctx = await testContext(fake, { event: 'issues', payload });
    expect(summary(await runJobs(ctx, deps))).toEqual(['readiness done: not ready: 6 problem(s)']);
  });

  it('starts no job for a trusted comment, or an event it does not know', async () => {
    const payload = { comment: { user: { login: 'SvenPGH' }, author_association: 'OWNER' } };
    expect(
      summary(await runJobs(await testContext(fake, { event: 'issue_comment', payload }), deps)),
    ).toEqual(['comment skipped: comments start no job']);
    expect(summary(await runJobs(await testContext(fake, { event: 'push' }), deps))).toEqual([
      'none skipped: no job runs on push',
    ]);
  });

  it('runs every act job on a Monday, filing from the analyze phase', async () => {
    const ctx = await testContext(fake, { now: MONDAY });
    const report = reportOf([
      finding('r/1', 'src/a.ts'),
      finding('config/drift', 'eslint.config.js', { check: 'configs/drift' }),
    ]);
    await writeFile(join(ctx.workdir, 'debt.json'), JSON.stringify(report));
    fake.addIssue({
      number: 50,
      labels: ['bug', 'status/in-progress', 'ai/claimed'],
      timeline: [
        {
          event: 'labeled',
          created_at: '2026-10-25T00:00:00Z',
          label: { name: 'status/in-progress' },
        },
      ],
    });
    fake.refs.set('T-50', 'sha-main');
    expect(summary(await runJobs(ctx, deps))).toEqual([
      'label-sync done: created 2, updated 0',
      'stale-claims done: released 1, kept 0, 0 failed',
      'flaky-tests done: filed 0 of 0 flaky test(s); 0 verdict(s) unreadable',
      'debt-issues done: filed 1 of 1 file(s) with debt',
      'sync-chore done: filed a sync chore',
    ]);
    expect([...fake.issues.values()].map((i) => i.title)).toEqual([
      'Issue 50',
      'Debt in src/a.ts (1 finding)',
      'Sync 1 generated config with the enforced Talos version',
    ]);
  });

  it('runs only the daily act jobs on other days', async () => {
    const ctx = await testContext(fake, { now: TUESDAY });
    expect(summary(await runJobs(ctx, deps))).toEqual([
      'label-sync done: created 2, updated 0',
      'stale-claims done: released 0, kept 0, 0 failed',
      'flaky-tests done: filed 0 of 0 flaky test(s); 0 verdict(s) unreadable',
      'debt-issues skipped: not due today',
      'sync-chore skipped: not due today',
    ]);
  });

  it('runs everything on a manual dispatch', async () => {
    const ctx = await testContext(fake, { event: 'workflow_dispatch', now: TUESDAY });
    const outcomes = await runJobs(ctx, deps);
    expect(outcomes.map((o) => o.result)).not.toContain('skipped');
    expect(summary(outcomes).at(-1)).toBe('sync-chore failed: no debt.json from the analyze phase');
  });

  it('keeps going when one job fails, and says what failed without content', async () => {
    fake.failures.set('GET repos/o/r/labels', 500);
    const ctx = await testContext(fake, { now: TUESDAY });
    expect(summary(await runJobs(ctx, deps)).slice(0, 2)).toEqual([
      'label-sync failed: GET repos/o/r/labels: 500',
      'stale-claims done: released 0, kept 0, 0 failed',
    ]);
  });

  it('fails the jobs that need a token it lacks', async () => {
    const noWorkflowToken = await testContext(fake, { now: TUESDAY, actions: undefined });
    const { download: _dropped, ...withoutDownload } = deps;
    expect(summary(await runJobs(noWorkflowToken, withoutDownload)).slice(1, 3)).toEqual([
      'stale-claims failed: no workflow token to delete stale branches with',
      "flaky-tests failed: no workflow token to read the gate's artifacts with",
    ]);
    const noReviewer = await testContext(fake, { now: TUESDAY, gh: undefined });
    expect(summary(await runJobs(noReviewer, deps))[0]).toBe(
      'label-sync failed: no reviewer token in the act phase',
    );
    const issues = await testContext(fake, {
      event: 'issues',
      gh: undefined,
      payload: { action: 'opened', issue: { number: 1 } },
    });
    expect(summary(await runJobs(issues, deps))).toEqual([
      'readiness failed: no reviewer token in the act phase',
    ]);
  });

  it('runs the weekly analysis in the analyze phase, with no token', async () => {
    const asked: string[][] = [];
    const analyze: AnalyzeDeps = {
      checks: { debt: ['ts/lint'], mutation: ['ts/mutation'] },
      run: (only) => {
        asked.push([...only]);
        return Promise.resolve(result([outcome('ts/lint', [finding('r/1', 'a.ts')])]));
      },
      summary: () => Promise.resolve(),
    };
    const ctx = await testContext(fake, {
      phase: 'analyze',
      now: MONDAY,
      gh: undefined,
      actions: undefined,
    });
    expect(summary(await runJobs(ctx, { ...deps, analyze }))).toEqual([
      'debt-run done: 1 finding(s) in 1 file(s)',
      'mutation-report done: 0 surviving mutant(s) in 0 file(s)',
    ]);
    expect(asked).toEqual([['ts/lint'], ['ts/mutation']]);
    expect(fake.calls).toEqual([]);
    const tuesday = await testContext(fake, { phase: 'analyze', now: TUESDAY });
    expect(summary(await runJobs(tuesday, { ...deps, analyze }))).toEqual([
      'debt-run skipped: not due today',
      'mutation-report skipped: not due today',
    ]);
    const missing = await testContext(fake, { phase: 'analyze', now: MONDAY });
    expect(summary(await runJobs(missing, deps))[0]).toBe(
      'debt-run failed: no engine in the analyze phase',
    );
  });

  it('runs no scheduled job from a branch other than the default', async () => {
    const ctx = await testContext(fake, {
      event: 'workflow_dispatch',
      env: { GITHUB_REF: 'refs/heads/R-4' },
      payload: { ref: 'refs/heads/R-4', repository: { default_branch: 'main' } },
    });
    const outcomes = await runJobs(ctx, deps);
    expect(outcomes.map((o) => o.detail)).toEqual(Array(5).fill('not run from the default branch'));
    expect(fake.calls).toEqual([]);
  });
});
