import { beforeAll, describe, expect, it } from 'vitest';
import type { InstallationState } from './installations.js';
import {
  codeownersText,
  GovernRefusal,
  governPlan,
  type GovernRequest,
  targetChannel,
} from './plan.js';
import type { LiveRuleset } from './rulesets-api.js';
import type { RepoState } from './state.js';
import type { Step } from './steps.js';
import {
  loadTemplates,
  ownerReviewRuleset,
  type RulesetBody,
  type Templates,
} from './templates.js';

let templates: Templates;
beforeAll(async () => {
  templates = await loadTemplates();
});

const CALLER = 'on: [pull_request_target]\n';
const OWNERS_TEMPLATE = '# owners\n* @OWNER\n';
const OWNERS = '# owners\n* @SvenPGH\n';
const REVIEWER_APP_ID = 5465977;

function ownerReview(): RulesetBody {
  return ownerReviewRuleset(templates.ownerReview, REVIEWER_APP_ID);
}

function live(body: RulesetBody, id: number): LiveRuleset {
  return { ...body, id };
}

function installations(member: boolean | undefined): InstallationState[] {
  return (['thea', 'reviewer', 'release'] as const).map((role, index) => ({
    role,
    slug: `${role}-app`,
    installation: { id: 10 + index, app_slug: `${role}-app`, repository_selection: 'selected' },
    member,
  }));
}

function fresh(overrides: Partial<RepoState> = {}): RepoState {
  return {
    repo: 'SVP-Labs/demo',
    id: 42,
    defaultBranch: 'main',
    head: 'h'.repeat(40),
    settings: {
      allow_rebase_merge: true,
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_auto_merge: false,
      delete_branch_on_merge: false,
      pull_request_creation_policy: 'all',
    },
    caller: undefined,
    codeowners: undefined,
    workflows: [],
    extra: {},
    rulesets: [],
    alerts: false,
    properties: {},
    installations: installations(false),
    ...overrides,
  };
}

function governed(overrides: Partial<RepoState> = {}): RepoState {
  return fresh({
    settings: {
      allow_rebase_merge: true,
      allow_squash_merge: false,
      allow_merge_commit: false,
      allow_auto_merge: true,
      delete_branch_on_merge: true,
      pull_request_creation_policy: 'collaborators_only',
    },
    caller: CALLER,
    codeowners: { path: '.github/CODEOWNERS', text: OWNERS },
    rulesets: [live(templates.mergeQueue, 1), live(ownerReview(), 2)],
    alerts: true,
    properties: { talos: 'evaluate', 'talos-agents': 'false' },
    installations: installations(true),
    ...overrides,
  });
}

function request(overrides: Partial<GovernRequest> = {}): GovernRequest {
  return {
    owner: 'SvenPGH',
    reviewerAppId: REVIEWER_APP_ID,
    agents: undefined,
    channel: undefined,
    caller: CALLER,
    codeowners: OWNERS_TEMPLATE,
    templates,
    ...overrides,
  };
}

function summary(steps: readonly Step[]): string[] {
  return steps.map((step) => `${step.status} ${step.id}`);
}

function effectOf(steps: readonly Step[], id: string): unknown {
  const step = steps.find((s) => s.id === id);
  return step?.status === 'change' ? step.effect : undefined;
}

describe('governPlan', () => {
  it('governs a fresh repository in order: files, settings, rulesets, alerts, properties, Apps', () => {
    const steps = governPlan(fresh(), request({ agents: true }));
    expect(summary(steps)).toEqual([
      'change files',
      'change settings',
      'manual issues',
      'change ruleset:talos-merge-queue',
      'change ruleset:talos-owner-review',
      'change alerts',
      'change properties',
      'change app:thea-app',
      'change app:reviewer-app',
      'change app:release-app',
    ]);
    expect(effectOf(steps, 'files')).toEqual({
      kind: 'commit',
      repo: 'SVP-Labs/demo',
      changes: {
        branch: 'main',
        expectedHead: 'h'.repeat(40),
        message: 'Govern the repository with Talos\n\nThe caller workflow and CODEOWNERS.',
        additions: [
          { path: '.github/workflows/talos.yml', contents: CALLER },
          { path: '.github/CODEOWNERS', contents: OWNERS },
        ],
        deletions: [],
      },
    });
    expect(effectOf(steps, 'settings')).toEqual({
      kind: 'patch-repo',
      repo: 'SVP-Labs/demo',
      body: {
        allow_squash_merge: false,
        allow_merge_commit: false,
        allow_auto_merge: true,
        delete_branch_on_merge: true,
        pull_request_creation_policy: 'collaborators_only',
      },
    });
    expect(effectOf(steps, 'properties')).toEqual({
      kind: 'set-properties',
      repo: 'SVP-Labs/demo',
      values: [
        { property_name: 'talos', value: 'evaluate' },
        { property_name: 'talos-agents', value: 'true' },
      ],
    });
    expect(effectOf(steps, 'app:reviewer-app')).toEqual({
      kind: 'install',
      installationId: 11,
      repositoryId: 42,
    });
  });

  it('changes nothing in a repository that is governed already', () => {
    const steps = governPlan(governed(), request());
    expect(steps.filter((s) => s.status === 'change')).toEqual([]);
    expect(summary(steps.filter((s) => s.status === 'manual'))).toEqual(['manual issues']);
  });

  it('moves to a channel by setting the property first, then deleting the owner rule', () => {
    const steps = governPlan(governed(), request({ channel: 'canary' }));
    expect(summary(steps.filter((s) => s.status === 'change'))).toEqual([
      'change properties',
      'change ruleset:talos-owner-review',
    ]);
    expect(effectOf(steps, 'ruleset:talos-owner-review')).toEqual({
      kind: 'delete-ruleset',
      scope: { kind: 'repo', repo: 'SVP-Labs/demo' },
      id: 2,
    });
  });

  it('requires talos/review from the reviewer App at evaluate, with no bypass', () => {
    const steps = governPlan(fresh(), request());
    expect(effectOf(steps, 'ruleset:talos-owner-review')).toEqual({
      kind: 'create-ruleset',
      scope: { kind: 'repo', repo: 'SVP-Labs/demo' },
      body: {
        ...templates.ownerReview,
        bypass_actors: [],
        rules: [
          {
            type: 'required_status_checks',
            parameters: {
              strict_required_status_checks_policy: false,
              required_status_checks: [
                { context: 'talos/review', integration_id: REVIEWER_APP_ID },
              ],
            },
          },
        ],
      },
    });
  });

  it("replaces an older owner rule that asked for a code owner's approval", () => {
    const older: LiveRuleset = {
      ...live(templates.ownerReview, 2),
      bypass_actors: [
        { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' },
      ],
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
            dismiss_stale_reviews_on_push: true,
            require_last_push_approval: true,
            required_review_thread_resolution: false,
          },
        },
      ],
    };
    const steps = governPlan(
      governed({ rulesets: [live(templates.mergeQueue, 1), older] }),
      request(),
    );
    expect(effectOf(steps, 'ruleset:talos-owner-review')).toEqual({
      kind: 'update-ruleset',
      scope: { kind: 'repo', repo: 'SVP-Labs/demo' },
      id: 2,
      body: ownerReview(),
    });
  });

  it('deletes an owner rule left behind on a repository already on a channel', () => {
    const state = governed({ properties: { talos: 'canary', 'talos-agents': 'false' } });
    const steps = governPlan(state, request());
    expect(summary(steps.filter((s) => s.status === 'change'))).toEqual([
      'change ruleset:talos-owner-review',
    ]);
    expect(effectOf(steps, 'ruleset:talos-owner-review')).toMatchObject({
      kind: 'delete-ruleset',
      id: 2,
    });
  });

  it('keeps a repository at its channel when rerun without --channel', () => {
    const state = governed({
      rulesets: [live(templates.mergeQueue, 1)],
      properties: { talos: 'stable', 'talos-agents': 'true' },
    });
    const steps = governPlan(state, request());
    expect(steps.filter((s) => s.status === 'change')).toEqual([]);
    expect(targetChannel(state, request())).toBe('stable');
  });

  it('refuses --channel for a repository that never came in at evaluate', () => {
    expect(() => governPlan(fresh(), request({ channel: 'stable' }))).toThrow(GovernRefusal);
  });

  it('turns a changed file into a manual step once the branch takes no direct commit', () => {
    const steps = governPlan(governed({ caller: 'old' }), request());
    const files = steps.find((s) => s.id === 'files');
    expect(files?.status).toBe('manual');
    expect(files?.detail).toMatch(/change them through a PR/);
  });

  it("deletes the old kit's callers and writes CODEOWNERS where the repository keeps it", () => {
    const state = fresh({
      codeowners: { path: 'CODEOWNERS', text: '* @someone\n' },
      workflows: [
        { path: '.github/workflows/gates.yml', text: 'uses: SVP-Labs/Workflows/x.yml@v0' },
        {
          path: '.github/workflows/repo-setup.yml',
          text: 'run: bash .github/scripts/apply-rulesets.sh',
        },
        { path: '.github/workflows/ci.yml', text: 'run: make' },
      ],
    });
    const effect = effectOf(governPlan(state, request()), 'files');
    expect(effect).toMatchObject({
      changes: {
        additions: [
          { path: '.github/workflows/talos.yml' },
          { path: 'CODEOWNERS', contents: OWNERS },
        ],
        deletions: ['.github/workflows/gates.yml', '.github/workflows/repo-setup.yml'],
      },
    });
  });

  it('adds seed files that are missing, and only those', () => {
    const state = fresh({ extra: { 'talos.yml': undefined, 'README.md': 'x' } });
    const effect = effectOf(
      governPlan(state, request({ seed: { 'talos.yml': 'name: X\n', 'README.md': 'y' } })),
      'files',
    );
    expect(effect).toMatchObject({
      changes: { additions: [{}, {}, { path: 'talos.yml', contents: 'name: X\n' }] },
    });
  });

  it('prints a manual step where GitHub does not report the PR creation policy', () => {
    const settings = { ...governed().settings };
    delete settings.pull_request_creation_policy;
    const steps = governPlan(governed({ settings }), request());
    expect(summary(steps)).toContain('manual pull-requests');
    expect(summary(steps)).toContain('ok settings');
  });

  it('updates a ruleset someone changed by hand', () => {
    const loosened = { ...live(templates.mergeQueue, 1), enforcement: 'disabled' };
    const steps = governPlan(governed({ rulesets: [loosened, live(ownerReview(), 2)] }), request());
    expect(effectOf(steps, 'ruleset:talos-merge-queue')).toMatchObject({
      kind: 'update-ruleset',
      id: 1,
    });
  });

  it('keeps talos-agents as the repository has it unless asked', () => {
    const state = governed({ properties: { talos: 'evaluate', 'talos-agents': 'true' } });
    expect(effectOf(governPlan(state, request()), 'properties')).toBeUndefined();
    expect(effectOf(governPlan(state, request({ agents: false })), 'properties')).toEqual({
      kind: 'set-properties',
      repo: 'SVP-Labs/demo',
      values: [{ property_name: 'talos-agents', value: 'false' }],
    });
  });

  it('asks for an App to be installed before a repository can be added to it', () => {
    const states = installations(true).map((s, i) =>
      i === 0 ? { ...s, installation: undefined } : s,
    );
    const steps = governPlan(governed({ installations: states }), request());
    expect(summary(steps)).toContain('manual app:thea-app');
  });
});

describe('codeownersText', () => {
  it("names the owner's login", () => {
    expect(codeownersText(OWNERS_TEMPLATE, 'SvenPGH')).toBe(OWNERS);
  });
});
