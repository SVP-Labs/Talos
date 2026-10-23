import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkSeed,
  orgPlan,
  type OrgState,
  pinsOf,
  PROPERTY_DEFINITIONS,
  readOrgState,
} from './org.js';
import { GovernRefusal } from './plan.js';
import type { LiveRuleset } from './rulesets-api.js';
import type { Step } from './steps.js';
import {
  channelRuleset,
  channelsBranchRuleset,
  loadTemplates,
  type RulesetBody,
  type Templates,
} from './templates.js';
import { fakeApi, json, route } from './test/fake-api.js';
import { identities } from '../github/identities.js';

const V1 = '1'.repeat(40);
const V2 = '2'.repeat(40);
const IDS = { talosRepositoryId: 500, reviewerAppId: 600 };

let templates: Templates;
beforeAll(async () => {
  templates = await loadTemplates();
});

function live(body: RulesetBody, id: number): LiveRuleset {
  return { ...body, id };
}

function state(overrides: Partial<OrgState> = {}): OrgState {
  return {
    org: 'SVP-Labs',
    talosRepo: 'SVP-Labs/Talos',
    ids: IDS,
    releaseAppId: 700,
    definitions: {},
    channels: [],
    talosRulesets: [],
    releases: [
      { tag: 'v0.1.0', sha: V1 },
      { tag: 'v0.2.0', sha: V2 },
    ],
    ...overrides,
  };
}

function setUp(): OrgState {
  return state({
    definitions: Object.fromEntries(
      Object.entries(PROPERTY_DEFINITIONS).map(([name, body]) => [
        name,
        { property_name: name, ...body },
      ]),
    ),
    channels: (['evaluate', 'canary', 'stable'] as const).map((channel, index) =>
      live(
        channelRuleset(templates.channel, channel, channel === 'canary' ? V2 : V1, IDS),
        index + 1,
      ),
    ),
    talosRulesets: [
      live(templates.releaseTags, 10),
      live(channelsBranchRuleset(templates.channelsBranch, 700), 11),
    ],
  });
}

function summary(steps: readonly Step[]): string[] {
  return steps.map((step) => `${step.status} ${step.id}`);
}

describe('orgPlan', () => {
  it('sets up an empty organisation from the seed, properties first', () => {
    const steps = orgPlan(state(), templates, V1);
    expect(summary(steps)).toEqual([
      'change property:talos',
      'change property:talos-agents',
      'change ruleset:talos-evaluate',
      'change ruleset:talos-canary',
      'change ruleset:talos-stable',
      'change ruleset:talos-release-tags',
      'change ruleset:talos-channels',
    ]);
    const canary = steps[3];
    expect(canary?.status === 'change' ? canary.effect : undefined).toMatchObject({
      kind: 'create-ruleset',
      scope: { kind: 'org', org: 'SVP-Labs' },
      body: { name: 'talos-canary', enforcement: 'active' },
    });
  });

  it('asks for a seed when a channel has no pin yet', () => {
    expect(summary(orgPlan(state(), templates)).filter((s) => s.startsWith('manual'))).toEqual([
      'manual ruleset:talos-evaluate',
      'manual ruleset:talos-canary',
      'manual ruleset:talos-stable',
    ]);
  });

  it('changes nothing once set up, and never moves an existing pin', () => {
    expect(orgPlan(setUp(), templates).every((step) => step.status === 'ok')).toBe(true);
    expect(orgPlan(setUp(), templates, V2).every((step) => step.status === 'ok')).toBe(true);
  });

  it('repairs a channel ruleset someone changed, keeping its pin', () => {
    const channels = setUp().channels.map((r) =>
      r.name === 'talos-stable' ? { ...r, enforcement: 'evaluate' } : r,
    );
    const steps = orgPlan(setUp(), templates);
    expect(steps.every((s) => s.status === 'ok')).toBe(true);
    const repaired = orgPlan({ ...setUp(), channels }, templates).find(
      (s) => s.status === 'change',
    );
    expect(repaired?.status === 'change' ? repaired.effect : undefined).toMatchObject({
      kind: 'update-ruleset',
      id: 3,
      body: { enforcement: 'active' },
    });
  });

  it('updates a property definition that differs', () => {
    const definitions = { talos: { property_name: 'talos', value_type: 'string' } };
    const steps = orgPlan({ ...setUp(), definitions }, templates);
    expect(summary(steps).slice(0, 2)).toEqual([
      'change property:talos',
      'change property:talos-agents',
    ]);
    expect(steps[0]?.detail).toBe('update the talos property');
  });
});

describe('checkSeed', () => {
  it('accepts only a release tag commit', () => {
    expect(() => {
      checkSeed(state(), V1);
    }).not.toThrow();
    expect(() => {
      checkSeed(state(), 'f'.repeat(40));
    }).toThrow(GovernRefusal);
    expect(() => {
      checkSeed(state(), undefined);
    }).not.toThrow();
  });
});

describe('pinsOf', () => {
  it('reports each channel with its tag', () => {
    expect(pinsOf(setUp().channels, setUp().releases)).toEqual([
      { channel: 'evaluate', sha: V1, tag: 'v0.1.0', enforcement: 'evaluate' },
      { channel: 'canary', sha: V2, tag: 'v0.2.0', enforcement: 'active' },
      { channel: 'stable', sha: V1, tag: 'v0.1.0', enforcement: 'active' },
    ]);
    expect(pinsOf([], [])[0]).toEqual({
      channel: 'evaluate',
      sha: null,
      tag: null,
      enforcement: null,
    });
  });
});

describe('readOrgState', () => {
  it('reads ids, definitions, rulesets and release tags', async () => {
    const canary = live(channelRuleset(templates.channel, 'canary', V2, IDS), 2);
    const api = fakeApi([
      route('GET', /^repos\/SVP-Labs\/Talos$/, json({ id: 500 })),
      route('GET', /^apps\/talos-reviewer$/, json({ id: 600, slug: 'talos-reviewer' })),
      route('GET', /^apps\/talos-release$/, json({ id: 700, slug: 'talos-release' })),
      route(
        'GET',
        /^orgs\/SVP-Labs\/properties\/schema$/,
        json([{ property_name: 'talos', value_type: 'single_select' }]),
      ),
      route(
        'GET',
        /^orgs\/SVP-Labs\/rulesets$/,
        json([
          { id: 2, name: 'talos-canary' },
          { id: 9, name: 'other' },
        ]),
      ),
      route('GET', /^orgs\/SVP-Labs\/rulesets\/2$/, json(canary)),
      route('GET', /^repos\/SVP-Labs\/Talos\/rulesets$/, json([])),
      route(
        'GET',
        /^repos\/SVP-Labs\/Talos\/tags$/,
        json([
          { name: 'v0.2.0', commit: { sha: V2 } },
          { name: 'nightly', commit: { sha: V1 } },
        ]),
      ),
    ]);
    const read = await readOrgState(api.client(), identities({}), templates);
    expect(read.ids).toEqual(IDS);
    expect(read.releaseAppId).toBe(700);
    expect(Object.keys(read.definitions)).toEqual(['talos']);
    expect(read.channels.map((r) => r.name)).toEqual(['talos-canary']);
    expect(read.releases).toEqual([{ tag: 'v0.2.0', sha: V2 }]);
  });
});
