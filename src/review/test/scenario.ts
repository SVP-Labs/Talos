import { app, BASE, FakePrGitHub, HEAD } from './fake.js';
import { parseConfig } from '../../config/load.js';
import type { TalosConfig } from '../../config/schema.js';
import { silentLogger } from '../../core/log.js';
import { identities } from '../../github/identities.js';
import type { JobContext } from '../../jobs/context.js';
import type { ReviewDeps } from '../job.js';
import type { ModelResult, ReviewModel } from '../model.js';
import type { Prompt } from '../prompt.js';

export const OWNER = 'SvenPGH';
export const THEA = 'thea-svp[bot]';
export const REVIEWER = 'talos-reviewer[bot]';
export const PR = 20;
export const ISSUE = 12;

const PR_BODY = [
  `Closes #${ISSUE}`,
  '',
  '## Problem',
  '',
  'src/a/util.ts has a magic number.',
  '',
  '## Discussion',
  '',
  'A named constant reads better than a comment.',
  '',
  '## Solution',
  '',
  'Name it, and test the value.',
].join('\n');

const ISSUE_BODY = [
  '### Goal',
  '',
  'Clear the finding in `src/a/util.ts`.',
  '',
  '### Acceptance criteria',
  '',
  '- [ ] `talos check` reports none of the findings below in `src/a/util.ts`',
  '',
  '### Affected areas',
  '',
  '- `src/a/util.ts`',
  '',
].join('\n');

const UTIL_PATCH =
  '@@ -1,3 +1,3 @@\n // util\n-export const a = 1;\n+export const a = 2;\n export const b = 3;';
const TEST_PATCH =
  "@@ -1,4 +1,5 @@\n import { a } from './util.js';\n it('a', () => {\n   expect(a).toBe(2);\n+  expect(a).toBeGreaterThan(1);\n });";

/** A debt PR from Thea meeting every condition: it passes once the reviewer approves. */
export function debtScenario(): FakePrGitHub {
  const fake = new FakePrGitHub();
  fake.pulls.set(PR, {
    number: PR,
    state: 'open',
    draft: false,
    title: 'Name the magic number in src/a/util.ts',
    body: PR_BODY,
    user: app(THEA),
    author_association: 'NONE',
    head: { sha: HEAD, ref: `T-${ISSUE}` },
    base: { ref: 'main', sha: BASE },
    commits: 1,
    changed_files: 2,
    labels: [],
  });
  fake.files.set(PR, [
    {
      filename: 'src/a/util.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: UTIL_PATCH,
    },
    {
      filename: 'src/a/util.test.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: TEST_PATCH,
    },
  ]);
  fake.commits.set(PR, [{ sha: HEAD, verified: true, author: app(THEA), committer: app(THEA) }]);
  fake.pullEvents.set(PR, []);
  fake.closing.set(PR, [`o/r#${ISSUE}`]);
  fake.issues.set(ISSUE, {
    number: ISSUE,
    title: 'Debt in src/a/util.ts (1 finding)',
    body: ISSUE_BODY,
    labels: ['debt/other', 'status/in-progress', 'ai/claimed', 'priority/p3'],
    events: [
      {
        event: 'labeled',
        label: 'debt/other',
        actor: app(REVIEWER),
        created_at: '2026-10-20T03:17:00Z',
      },
    ],
  });
  fake.contents.set('main:.github/CODEOWNERS', `* @${OWNER}\n`);
  fake.contents.set('main:CLAUDE.md', '# CLAUDE.md\n\nKeep functions small.\n');
  fake.contents.set(`${HEAD}:src/a/util.ts`, '// util\nexport const a = 2;\nexport const b = 3;\n');
  fake.contents.set(`${HEAD}:src/a/util.test.ts`, "import { a } from './util.js';\n");
  return fake;
}

const CONFIG = 'name: Test\nprefix: T\nprotected: [src/risk/**]\n';

export type FakeModel = ReviewModel & { readonly prompts: Prompt[] };

/** A model that answers each review with the next result, the last one repeating. */
export function fakeModel(...results: ModelResult[]): FakeModel {
  const prompts: Prompt[] = [];
  return {
    prompts,
    review: (prompt) => {
      prompts.push(prompt);
      const result = results[Math.min(prompts.length - 1, results.length - 1)];
      return Promise.resolve(result ?? { ok: false, reason: 'no answer scripted' });
    },
  };
}

export const APPROVE: ModelResult = {
  ok: true,
  answer: { verdict: 'APPROVE', summary: 'The constant is named and tested.', comments: [] },
};

export function deps(model: ReviewModel): ReviewDeps {
  return {
    model,
    extensions: ['eslint.project.js', 'tsconfig.json'],
    rubric: () => Promise.resolve('# Review a pull request\n\nAnswer with JSON.'),
    engineering: () => Promise.resolve('# ENGINEERING\n'),
  };
}

export function pullPayload(action: string, sha = HEAD): Record<string, unknown> {
  return {
    action,
    number: PR,
    pull_request: { number: PR, head: { sha, ref: `T-${ISSUE}` }, base: { ref: 'main' } },
    repository: { full_name: 'o/r', default_branch: 'main' },
    sender: { login: THEA },
  };
}

export function reviewPayload(
  login: string,
  association: string,
  state = 'approved',
): Record<string, unknown> {
  return {
    action: 'submitted',
    review: { id: 1, user: { login }, author_association: association, state, commit_id: HEAD },
    pull_request: { number: PR, head: { sha: HEAD } },
    repository: { full_name: 'o/r', default_branch: 'main' },
    sender: { login },
  };
}

export type TestContext = JobContext & { readonly configRefs: string[] };

/** The act phase of the caller on `o/r`, as the reviewer, reading `talos.yml` at any ref. */
export function jobContext(
  fake: FakePrGitHub,
  overrides: Partial<JobContext> = {},
  config = CONFIG,
): TestContext {
  const configRefs: string[] = [];
  const parsed: TalosConfig = parseConfig(config);
  return {
    event: 'pull_request_target',
    payload: pullPayload('synchronize'),
    repo: 'o/r',
    phase: 'act',
    gh: fake.client(),
    who: identities({}),
    env: {},
    now: new Date('2026-10-23T12:00:00Z'),
    log: silentLogger,
    workdir: '/nonexistent',
    config: (ref) => {
      configRefs.push(ref);
      return Promise.resolve(parsed);
    },
    configRefs,
    ...overrides,
  };
}
