import { describe, expect, it } from 'vitest';
import {
  channelRulesetName,
  movedBody,
  movePin,
  type OrgRuleset,
  pinHistory,
  pinOfRules,
  pinsOf,
  readChannelRulesets,
  withPin,
} from './org-rulesets.js';
import { fakeGitHub } from './test/fake-github.js';

const TALOS = 900;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const workflows = (...refs: object[]) => ({ type: 'workflows', parameters: { workflows: refs } });
const gate = (sha?: string, extra: object = {}) => ({
  path: '.github/workflows/gate.yml',
  repository_id: TALOS,
  ...(sha === undefined ? {} : { sha }),
  ...extra,
});
const review = {
  type: 'required_status_checks',
  parameters: { required_status_checks: [{ context: 'talos/review' }] },
};

function ruleset(id: number, name: string, rules: object[]): OrgRuleset {
  return { id, name, target: 'branch', enforcement: 'active', bypass_actors: [], rules } as never;
}

describe('pinOfRules', () => {
  it("reads the one commit the Talos workflows agree on, ignoring other repositories'", () => {
    const other = { path: 'x.yml', repository_id: 5, sha: B };
    expect(pinOfRules([review, workflows(gate(A), other)], TALOS)).toBe(A);
    expect(pinOfRules([workflows(gate(A)), workflows(gate(A))], TALOS)).toBe(A);
  });

  it('reads no pin from disagreement, a ref, a non-commit or a malformed rule', () => {
    expect(pinOfRules([workflows(gate(A), gate(B))], TALOS)).toBeUndefined();
    expect(pinOfRules([workflows(gate(undefined, { ref: 'v1' }))], TALOS)).toBeUndefined();
    expect(pinOfRules([workflows(gate('v1.0.0'))], TALOS)).toBeUndefined();
    expect(pinOfRules([{ type: 'workflows', parameters: { nope: 1 } }], TALOS)).toBeUndefined();
    expect(pinOfRules([review], TALOS)).toBeUndefined();
  });
});

describe('withPin and movedBody', () => {
  it("moves only the Talos workflows' pin, dropping a ref, and keeps everything else", () => {
    const other = { path: 'x.yml', repository_id: 5, sha: B };
    const rules = [
      review,
      workflows(gate(A, { ref: 'refs/heads/main' }), other),
      { type: 'workflows', parameters: 'odd' },
    ];
    const moved = withPin(rules, TALOS, B);
    expect(moved[0]).toBe(review);
    expect(moved[1]).toEqual(workflows(gate(B), other));
    expect(moved[2]).toBe(rules[2]);
  });

  it('builds the update body from the ruleset as it is', () => {
    const current = {
      ...ruleset(3, 'talos-canary', [workflows(gate(A))]),
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      _links: { self: { href: 'x' } },
    } as OrgRuleset;
    expect(movedBody(current, TALOS, B)).toEqual({
      name: 'talos-canary',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [workflows(gate(B))],
    });
    const bare = { id: 1, name: 'n', enforcement: 'evaluate', rules: [] } as OrgRuleset;
    expect(movedBody(bare, TALOS, B)).toEqual({
      name: 'n',
      enforcement: 'evaluate',
      bypass_actors: [],
      rules: [],
    });
  });
});

describe('the channel rulesets on GitHub', () => {
  it('reads each channel by name, and a missing one as undefined', async () => {
    const fake = fakeGitHub({
      'GET orgs/SVP-Labs/rulesets': {
        body: [
          { id: 1, name: 'talos-canary' },
          { id: 2, name: 'talos-stable' },
          { id: 3, name: 'something-else' },
        ],
      },
      'GET orgs/SVP-Labs/rulesets/1': { body: ruleset(1, 'talos-canary', [workflows(gate(A))]) },
      'GET orgs/SVP-Labs/rulesets/2': { body: ruleset(2, 'talos-stable', [workflows(gate(B))]) },
    });
    const rulesets = await readChannelRulesets(fake.gh, 'SVP-Labs');
    expect(rulesets.evaluate).toBeUndefined();
    expect(rulesets.canary?.id).toBe(1);
    expect(pinsOf(rulesets, TALOS)).toEqual({ evaluate: undefined, canary: A, stable: B });
    expect(fake.unmatched).toEqual([]);
    expect(channelRulesetName('evaluate')).toBe('talos-evaluate');
  });

  it('moves a pin with PUT', async () => {
    const fake = fakeGitHub({ 'PUT orgs/SVP-Labs/rulesets/1': { body: {} } });
    await movePin(
      fake.gh,
      { org: 'SVP-Labs', talosId: TALOS },
      ruleset(1, 'talos-canary', [workflows(gate(A))]),
      B,
    );
    expect(fake.calls).toEqual([
      {
        method: 'PUT',
        path: 'orgs/SVP-Labs/rulesets/1',
        body: {
          name: 'talos-canary',
          target: 'branch',
          enforcement: 'active',
          bypass_actors: [],
          rules: [workflows(gate(B))],
        },
      },
    ]);
  });

  it('reads the history back to the version before the pin', async () => {
    const version = (id: number, at: string, sha: string) => ({
      body: { version_id: id, updated_at: at, state: { rules: [workflows(gate(sha))] } },
    });
    const fake = fakeGitHub({
      'GET orgs/SVP-Labs/rulesets/1/history': {
        body: [
          {
            version_id: 3,
            updated_at: '2026-10-20T00:00:00Z',
            actor: { id: 1, type: 'Integration' },
          },
          {
            version_id: 2,
            updated_at: '2026-10-16T00:00:00Z',
            actor: { id: 1, type: 'Integration' },
          },
          { version_id: 1, updated_at: '2026-10-01T00:00:00Z', actor: { id: 2, type: 'User' } },
        ],
      },
      'GET orgs/SVP-Labs/rulesets/1/history/3': version(3, '2026-10-20T00:00:00Z', B),
      'GET orgs/SVP-Labs/rulesets/1/history/2': version(2, '2026-10-16T00:00:00Z', A),
    });
    const history = await pinHistory(fake.gh, { org: 'SVP-Labs', talosId: TALOS }, 1, B);
    expect(history).toEqual([
      { at: '2026-10-20T00:00:00Z', sha: B },
      { at: '2026-10-16T00:00:00Z', sha: A },
    ]);
    expect(fake.unmatched).toEqual([]);
  });
});
