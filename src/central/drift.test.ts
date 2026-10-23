import { describe, expect, it } from 'vitest';
import {
  type Difference,
  differences,
  driftIssue,
  driftKey,
  driftMarker,
  type DriftState,
  type Expected,
  GOVERNED_SETTINGS,
  holds,
  reconcile,
} from './drift.js';
import { judgeReadiness } from '../jobs/readiness.js';

const QUEUE = {
  name: 'talos-merge-queue',
  enforcement: 'active',
  bypass_actors: [],
  rules: [{ type: 'deletion' }, { type: 'merge_queue', parameters: { merge_method: 'REBASE' } }],
};

const OWNER_REVIEW = {
  name: 'talos-owner-review',
  bypass_actors: [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' }],
  rules: [
    {
      type: 'pull_request',
      parameters: { required_approving_review_count: 1, require_code_owner_review: true },
    },
  ],
};

const EXPECTED: Expected = {
  settings: GOVERNED_SETTINGS,
  caller: 'caller\n',
  codeowners: '* @SvenPGH\n',
  mergeQueue: QUEUE,
  ownerReview: OWNER_REVIEW,
};

const GOOD: DriftState = {
  settings: { ...GOVERNED_SETTINGS, id: 1, full_name: 'o/r' },
  alerts: true,
  channel: 'stable',
  caller: 'caller\n',
  codeowners: '* @SvenPGH\r\n',
  rulesets: {
    'talos-merge-queue': {
      ...QUEUE,
      id: 9,
      _links: {},
      rules: [
        { type: 'merge_queue', parameters: { merge_method: 'REBASE', max_entries_to_build: 5 } },
        { type: 'deletion' },
      ],
    },
  },
};

describe('holds', () => {
  it('asks only for what Talos sets, arrays in any order and as long', () => {
    expect(holds({ a: 1, b: [2, 3], c: 'x' }, { a: 1, b: [3, 2] })).toBe(true);
    expect(holds({ a: 1, b: [2, 3, 4] }, { b: [3, 2] })).toBe(false);
    expect(holds({ b: [2, 2] }, { b: [2, 3] })).toBe(false);
    expect(holds({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    expect(holds([], {})).toBe(false);
    expect(holds({}, [])).toBe(false);
    expect(holds(null, null)).toBe(true);
    expect(holds(undefined, [])).toBe(false);
  });
});

describe('differences', () => {
  it('finds none in a repository as govern left it', () => {
    expect(differences(GOOD, EXPECTED)).toEqual([]);
  });

  it('finds each changed setting, but not one the token could not read', () => {
    const settings = {
      ...GOOD.settings,
      allow_squash_merge: true,
      delete_branch_on_merge: undefined,
      pull_request_creation_policy: { odd: 1 },
    };
    expect(differences({ ...GOOD, settings }, EXPECTED)).toEqual([
      {
        key: 'setting:allow_squash_merge',
        what: '`allow_squash_merge`',
        expected: 'false',
        actual: 'true',
      },
      {
        key: 'setting:pull_request_creation_policy',
        what: '`pull_request_creation_policy`',
        expected: 'collaborators_only',
        actual: 'set',
      },
    ]);
  });

  it('finds alerts off, a missing channel, and changed or missing files', () => {
    const keys = (state: Partial<DriftState>): string[] =>
      differences({ ...GOOD, ...state }, EXPECTED).map((d) => d.key);
    expect(keys({ alerts: false })).toEqual(['alerts']);
    expect(keys({ alerts: undefined })).toEqual([]);
    expect(keys({ channel: undefined })).toEqual(['property:talos']);
    expect(keys({ channel: 'beta' })).toEqual(['property:talos']);
    expect(keys({ caller: undefined, codeowners: '* @someone\n' })).toEqual([
      'file:caller',
      'file:codeowners',
    ]);
    const missing = differences({ ...GOOD, caller: undefined }, EXPECTED)[0];
    expect(missing).toMatchObject({ expected: "Talos's copy", actual: 'missing' });
  });

  it('finds the merge queue missing or changed', () => {
    const changed = {
      ...(GOOD.rulesets['talos-merge-queue'] as object),
      bypass_actors: [{ actor_id: 1 }],
    };
    expect(differences({ ...GOOD, rulesets: { 'talos-merge-queue': changed } }, EXPECTED)).toEqual([
      {
        key: 'ruleset:talos-merge-queue',
        what: 'the `talos-merge-queue` ruleset',
        expected: 'present, as Talos creates it',
        actual: 'changed',
      },
    ]);
    expect(differences({ ...GOOD, rulesets: {} }, EXPECTED)[0]?.actual).toBe('missing');
  });

  it('finds the owner-review ruleset changed while it is the only approval gate', () => {
    const atEvaluate = { ...GOOD, channel: 'evaluate' };
    const weakened = [
      {
        ...OWNER_REVIEW,
        id: 4,
        rules: [
          {
            type: 'pull_request',
            parameters: { required_approving_review_count: 1, require_code_owner_review: false },
          },
        ],
      },
      {
        ...OWNER_REVIEW,
        bypass_actors: [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
      },
    ];
    for (const review of weakened) {
      const rulesets = { ...GOOD.rulesets, 'talos-owner-review': review };
      expect(differences({ ...atEvaluate, rulesets }, EXPECTED)).toEqual([
        {
          key: 'ruleset:talos-owner-review',
          what: 'the `talos-owner-review` ruleset',
          expected: 'present while at evaluate, as Talos creates it',
          actual: 'changed',
        },
      ]);
    }
  });

  it('wants the owner-review ruleset at evaluate and gone on a channel', () => {
    const review = { 'talos-owner-review': { ...OWNER_REVIEW, id: 4, _links: {} } };
    const atEvaluate = { ...GOOD, channel: 'evaluate' };
    expect(differences(atEvaluate, EXPECTED).map((d) => [d.key, d.actual])).toEqual([
      ['ruleset:talos-owner-review', 'missing'],
    ]);
    expect(
      differences({ ...atEvaluate, rulesets: { ...GOOD.rulesets, ...review } }, EXPECTED),
    ).toEqual([]);
    expect(differences({ ...GOOD, rulesets: { ...GOOD.rulesets, ...review } }, EXPECTED)).toEqual([
      {
        key: 'ruleset:talos-owner-review',
        what: 'the `talos-owner-review` ruleset',
        expected: 'gone once on a channel',
        actual: 'present',
      },
    ]);
  });
});

describe('the drift issue', () => {
  const diff: Difference = {
    key: 'setting:allow_squash_merge',
    what: '`allow_squash_merge`',
    expected: 'false',
    actual: 'true',
  };

  it('carries a hidden marker a later run finds it by', () => {
    const draft = driftIssue(diff);
    const encoded = encodeURIComponent(diff.key);
    expect(draft.body.split('\n')[0]).toBe(`<!-- talos-drift/1 key=${encoded} -->`);
    expect(encoded).not.toContain(':');
    expect(driftKey(draft.body)).toBe('setting:allow_squash_merge');
    expect(driftKey('talos-drift/1 key=a%20b\nrest')).toBe('a b');
    expect(driftKey('talos-drift/1 key=%E0%A4%A')).toBeUndefined();
    expect(driftKey('talos-debt/1 key=x')).toBeUndefined();
    expect(driftKey('')).toBeUndefined();
    expect(driftMarker('a b')).toBe('<!-- talos-drift/1 key=a%20b -->');
  });

  it('is a drift chore that passes issue readiness', () => {
    const draft = driftIssue(diff);
    expect(draft.title).toBe('Drift: allow_squash_merge differs from what talos govern sets');
    expect(draft.labels).toEqual(['drift', 'chore', 'priority/p2']);
    expect(draft.body).toContain('Expected: false. Actual: true.');
    const verdict = judgeReadiness({
      body: draft.body,
      labels: draft.labels,
      briefsDir: 'docs/requirements',
      briefs: new Map(),
    });
    expect(verdict).toEqual({ ready: true, problems: [] });
  });
});

describe('reconcile', () => {
  const issue = (number: number, key: string) => ({ number, body: `${driftMarker(key)}\n\ntext` });
  const diff = (key: string): Difference => ({ key, what: key, expected: 'x', actual: 'y' });
  const all = (): boolean => true;

  it('files what is new and closes what is gone', () => {
    const open = [issue(1, 'alerts'), issue(2, 'file:caller'), { number: 3, body: 'no marker' }];
    expect(reconcile([diff('alerts'), diff('setting:x')], open, all)).toEqual({
      file: [diff('setting:x')],
      close: [2],
    });
  });

  it('leaves the keys another check owns alone', () => {
    const mine = (key: string): boolean => key.startsWith('channels-json:');
    const open = [issue(1, 'alerts'), issue(2, 'channels-json:canary')];
    expect(reconcile([diff('channels-json:stable'), diff('alerts')], open, mine)).toEqual({
      file: [diff('channels-json:stable')],
      close: [2],
    });
  });
});
