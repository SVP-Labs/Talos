import { beforeEach, describe, expect, it } from 'vitest';
import { eventSkip, readinessJob } from './readiness-job.js';
import { testContext } from './test/context.js';
import { identities } from '../github/identities.js';
import { FakeGitHub } from '../ticket/test/fake-github.js';

const who = identities({});

const READY_BODY = `### Goal

Do it.

### Acceptance criteria

- [ ] done

### Out of scope

Else.

### Affected areas

- \`src/a.ts\`
`;

function event(
  action: string,
  number: number,
  author = { login: 'SvenPGH', association: 'OWNER' },
  sender = 'SvenPGH',
): Record<string, unknown> {
  return {
    action,
    issue: { number, user: { login: author.login }, author_association: author.association },
    sender: { login: sender },
    repository: { default_branch: 'main' },
  };
}

describe('eventSkip', () => {
  it('judges an owner, member, collaborator or Thea opening or editing an issue', () => {
    for (const action of ['opened', 'edited', 'reopened', 'labeled', 'unlabeled']) {
      const parsed = { action, issue: { number: 1, user: { login: 'x' }, author_association: 'MEMBER' } };
      expect(eventSkip({ ...parsed, sender: { login: 'x' } }, who)).toBeUndefined();
    }
    const thea = { action: 'opened', issue: { number: 1, user: { login: 'thea-svp[bot]' }, author_association: 'NONE' } };
    expect(eventSkip(thea, who)).toBeUndefined();
  });

  it('skips other actions, its own changes, strangers and its own issues', () => {
    const base = { number: 1, user: { login: 'x' }, author_association: 'OWNER' };
    expect(eventSkip({ action: 'closed', issue: base }, who)).toMatch(/closed/);
    expect(eventSkip({ action: 'labeled', issue: base, sender: { login: who.reviewer } }, who)).toMatch(
      /own change/,
    );
    expect(
      eventSkip({ action: 'opened', issue: { ...base, author_association: 'CONTRIBUTOR' } }, who),
    ).toBe('author not trusted');
    expect(
      eventSkip(
        { action: 'opened', issue: { number: 1, user: { login: who.reviewer }, author_association: 'NONE' } },
        who,
      ),
    ).toBe('filed by Talos');
  });
});

describe('readinessJob', () => {
  let fake: FakeGitHub;

  beforeEach(() => {
    fake = new FakeGitHub();
  });

  async function run(payload: Record<string, unknown>): Promise<string> {
    const ctx = await testContext(fake, { event: 'issues', payload });
    const outcome = await readinessJob(ctx, fake.client());
    return `${outcome.result}: ${outcome.detail}`;
  }

  it('flags an issue that is not ready, once, and follows its edits', async () => {
    fake.addIssue({ number: 4, body: '### Goal\n\nx', labels: ['feature', 'status/ready'] });
    expect(await run(event('opened', 4))).toBe('done: not ready: 3 problem(s)');
    const issue = fake.issues.get(4);
    expect(issue?.labels).toEqual(['feature', 'needs-spec']);
    expect(issue?.comments).toHaveLength(1);
    expect(issue?.comments[0]?.body).toContain('a `## Out of scope` section');

    if (issue !== undefined) issue.body = READY_BODY.replace('- [ ] done', 'done');
    expect(await run(event('edited', 4))).toBe('done: not ready: 1 problem(s)');
    expect(issue?.comments).toHaveLength(1);
    expect(issue?.comments[0]?.body).toContain('at least one `- [ ]` checkbox');

    if (issue !== undefined) issue.body = READY_BODY;
    expect(await run(event('edited', 4))).toBe('done: ready');
    expect(issue?.labels).toEqual(['feature', 'status/ready']);
    expect(issue?.comments).toHaveLength(1);
    expect(issue?.comments[0]?.body).toContain('**Ready.**');

    const before = fake.writes().length;
    expect(await run(event('edited', 4))).toBe('done: ready');
    expect(fake.writes()).toHaveLength(before);
  });

  it('makes a ready issue ready without a comment', async () => {
    fake.addIssue({ number: 5, body: READY_BODY, labels: ['chore'] });
    expect(await run(event('opened', 5))).toBe('done: ready');
    expect(fake.issues.get(5)?.labels).toEqual(['chore', 'status/ready']);
    expect(fake.issues.get(5)?.comments).toEqual([]);
  });

  it("ignores someone else's comment that copies the marker", async () => {
    fake.addIssue({ number: 6, body: '### Goal\n\nx', labels: ['feature'] });
    fake.issues.get(6)?.comments.push({
      id: 1,
      body: '<!-- talos-readiness/1 -->\nfake',
      user: 'SvenPGH',
      author_association: 'OWNER',
      created_at: fake.now,
    });
    await run(event('opened', 6));
    expect(fake.issues.get(6)?.comments).toHaveLength(2);
    expect(fake.issues.get(6)?.comments[0]?.body).toContain('fake');
  });

  it('checks the brief of an epic on the default branch', async () => {
    const body = '### Goal\n\nAll.\n\n### Brief\n\ndocs/requirements/20261023-billing.md\n\n### Out of scope\n\nLater.';
    fake.addIssue({ number: 7, body, labels: ['epic'] });
    expect(await run(event('opened', 7))).toBe('done: not ready: 1 problem(s)');
    fake.files.set('docs/requirements/20261023-billing.md', '# Billing');
    expect(await run(event('edited', 7))).toBe('done: ready');
    expect(fake.issues.get(7)?.labels).toEqual(['epic']);
  });

  it('leaves legacy, closed and missing issues alone', async () => {
    fake.addIssue({ number: 8, body: '', labels: ['legacy'] });
    fake.addIssue({ number: 9, body: '', state: 'closed' });
    expect(await run(event('edited', 8))).toBe('skipped: legacy');
    expect(await run(event('reopened', 9))).toBe('skipped: not open');
    expect(await run(event('edited', 10))).toBe('skipped: not open');
    expect(fake.writes()).toEqual([]);
  });

  it('makes no API call for a stranger', async () => {
    fake.addIssue({ number: 11 });
    const stranger = { login: 'mallory', association: 'NONE' };
    expect(await run(event('opened', 11, stranger, 'mallory'))).toBe('skipped: author not trusted');
    expect(fake.calls).toEqual([]);
  });
});
