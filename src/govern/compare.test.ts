import { describe, expect, it } from 'vitest';
import { covers, rulesetMatches } from './compare.js';
import { loadTemplates } from './templates.js';

describe('covers', () => {
  it('matches scalars exactly', () => {
    expect(covers(1, 1)).toBe(true);
    expect(covers('a', 'b')).toBe(false);
    expect(covers(undefined, 'a')).toBe(false);
  });

  it('lets the answer carry more keys than the request', () => {
    expect(covers({ a: 1, b: 2 }, { a: 1 })).toBe(true);
    expect(covers({ a: 1 }, { a: 2 })).toBe(false);
    expect(covers([1], { a: 1 })).toBe(false);
  });

  it('treats an empty value as matching a key GitHub left out', () => {
    expect(covers({}, { exclude: [], strict: false, id: null })).toBe(true);
    expect(covers({}, { include: ['x'] })).toBe(false);
  });

  it('compares arrays in any order, at the same length', () => {
    expect(covers([{ t: 'b' }, { t: 'a', x: 1 }], [{ t: 'a' }, { t: 'b' }])).toBe(true);
    expect(covers([{ t: 'a' }], [{ t: 'a' }, { t: 'a' }])).toBe(false);
    expect(covers([{ t: 'a' }, { t: 'c' }], [{ t: 'a' }, { t: 'b' }])).toBe(false);
    expect(covers({ a: 1 }, [1])).toBe(false);
  });
});

describe('rulesetMatches', () => {
  it("accepts GitHub's answer for the owner-review ruleset", async () => {
    const { ownerReview } = await loadTemplates();
    const answer = {
      id: 9,
      name: 'talos-owner-review',
      target: 'branch',
      source_type: 'Repository',
      source: 'o/r',
      enforcement: 'active',
      bypass_actors: [
        { actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' },
      ],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
      rules: [
        {
          type: 'pull_request',
          parameters: {
            ...ownerReview.rules[0]?.parameters,
            allowed_merge_methods: ['merge', 'squash', 'rebase'],
            automatic_copilot_code_review_enabled: false,
          },
        },
      ],
      _links: { self: { href: 'x' } },
    };
    expect(rulesetMatches(answer, ownerReview)).toBe(true);
    const loosened = {
      ...answer,
      bypass_actors: [{ actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
    };
    expect(rulesetMatches(loosened, ownerReview)).toBe(false);
    expect(rulesetMatches({ ...answer, enforcement: 'evaluate' }, ownerReview)).toBe(false);
  });

  it('notices a rule someone added by hand', async () => {
    const { mergeQueue } = await loadTemplates();
    const answer = { ...mergeQueue, rules: [...mergeQueue.rules, { type: 'required_signatures' }] };
    expect(rulesetMatches(mergeQueue, mergeQueue)).toBe(true);
    expect(rulesetMatches(answer, mergeQueue)).toBe(false);
  });
});
