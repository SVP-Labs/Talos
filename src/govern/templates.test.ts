import { describe, expect, it } from 'vitest';
import {
  channelRuleset,
  channelRulesetName,
  channelsBranchRuleset,
  isChannel,
  loadTemplates,
  parseTemplate,
  pinOf,
  type Templates,
} from './templates.js';

const SHA = 'a'.repeat(40);
const IDS = { talosRepositoryId: 101, reviewerAppId: 202 };

async function templates(): Promise<Templates> {
  return loadTemplates();
}

/** The parameters GitHub's REST schema marks required, per rule type. */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  pull_request: [
    'dismiss_stale_reviews_on_push',
    'require_code_owner_review',
    'require_last_push_approval',
    'required_approving_review_count',
    'required_review_thread_resolution',
  ],
  merge_queue: [
    'check_response_timeout_minutes',
    'grouping_strategy',
    'max_entries_to_build',
    'max_entries_to_merge',
    'merge_method',
    'min_entries_to_merge',
    'min_entries_to_merge_wait_minutes',
  ],
  required_status_checks: ['required_status_checks', 'strict_required_status_checks_policy'],
  workflows: ['workflows'],
};

describe('the ruleset templates', () => {
  it('give every rule the parameters GitHub requires', async () => {
    const all = await templates();
    for (const body of Object.values(all)) {
      for (const rule of body.rules) {
        for (const key of REQUIRED[rule.type] ?? []) expect(rule.parameters).toHaveProperty(key);
      }
    }
  });

  it('require the merge queue on the default branch, rebasing, with no bypass', async () => {
    const { mergeQueue } = await templates();
    expect(mergeQueue.enforcement).toBe('active');
    expect(mergeQueue.bypass_actors).toEqual([]);
    expect(mergeQueue.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH']);
    const queue = mergeQueue.rules.find((rule) => rule.type === 'merge_queue');
    expect(queue?.parameters).toMatchObject({
      merge_method: 'REBASE',
      grouping_strategy: 'ALLGREEN',
    });
    const pr = mergeQueue.rules.find((rule) => rule.type === 'pull_request');
    expect(pr?.parameters).toMatchObject({
      required_approving_review_count: 0,
      allowed_merge_methods: ['rebase'],
    });
  });

  it("carry the owner's review rule exactly, with an org admin bypass on PRs only", async () => {
    const { ownerReview } = await templates();
    expect(ownerReview.rules).toEqual([
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
    ]);
    expect(ownerReview.bypass_actors).toEqual([
      { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' },
    ]);
  });

  it('limit release tags to the owner, and the channels branch to talos-release', async () => {
    const { releaseTags, channelsBranch } = await templates();
    expect(releaseTags.target).toBe('tag');
    expect(releaseTags.conditions.ref_name.include).toEqual(['refs/tags/v*']);
    expect(releaseTags.rules.map((r) => r.type)).toEqual(['creation', 'update', 'deletion']);
    const branch = channelsBranchRuleset(channelsBranch, 77);
    expect(branch.conditions.ref_name.include).toEqual(['refs/heads/channels']);
    expect(branch.bypass_actors).toEqual([
      { actor_id: 77, actor_type: 'Integration', bypass_mode: 'always' },
    ]);
  });

  it('refuse a template that is not a ruleset', () => {
    expect(() => parseTemplate('x', '{"name":"x"}')).toThrow(/assets\/rulesets\/x\.json/);
  });
});

describe('channelRuleset', () => {
  it('pins the gate and requires talos/review from the reviewer App', async () => {
    const { channel } = await templates();
    const body = channelRuleset(channel, 'canary', SHA, IDS);
    expect(body.name).toBe('talos-canary');
    expect(body.enforcement).toBe('active');
    expect(body.bypass_actors).toEqual([]);
    expect(body.conditions.repository_property?.include).toEqual([
      { name: 'talos', property_values: ['canary'] },
    ]);
    expect(body.rules).toEqual([
      {
        type: 'workflows',
        parameters: {
          workflows: [{ path: '.github/workflows/gate.yml', repository_id: 101, sha: SHA }],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [{ context: 'talos/review', integration_id: 202 }],
        },
      },
    ]);
    expect(pinOf(body.rules)).toBe(SHA);
  });

  it('puts evaluate in Evaluate mode and the others in Active mode', async () => {
    const { channel } = await templates();
    expect(channelRuleset(channel, 'evaluate', SHA, IDS).enforcement).toBe('evaluate');
    expect(channelRuleset(channel, 'stable', SHA, IDS).enforcement).toBe('active');
  });

  it('refuses a template without a property condition', async () => {
    const { mergeQueue } = await templates();
    expect(() => channelRuleset(mergeQueue, 'stable', SHA, IDS)).toThrow(/targets no property/);
  });
});

describe('pinOf and the channel names', () => {
  it('reads only a full SHA from a workflows rule', () => {
    expect(pinOf([{ type: 'deletion' }])).toBeUndefined();
    expect(pinOf([{ type: 'workflows', parameters: { workflows: [] } }])).toBeUndefined();
    const ref = { path: 'p', repository_id: 1, ref: 'refs/heads/main' };
    expect(pinOf([{ type: 'workflows', parameters: { workflows: [ref] } }])).toBeUndefined();
    const short = { path: 'p', repository_id: 1, sha: 'abc' };
    expect(pinOf([{ type: 'workflows', parameters: { workflows: [short] } }])).toBeUndefined();
  });

  it('knows the three channels', () => {
    expect(isChannel('canary')).toBe(true);
    expect(isChannel('beta')).toBe(false);
    expect(isChannel(undefined)).toBe(false);
    expect(channelRulesetName('evaluate')).toBe('talos-evaluate');
  });
});
