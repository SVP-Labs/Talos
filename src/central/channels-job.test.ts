import { describe, expect, it } from 'vitest';
import { channelsText } from './channels-file.js';
import { type ChannelsDeps, mergeMoves, runChannels } from './channels-job.js';
import { canaryRepositories, tallyGateRuns } from './gate-runs.js';
import { type Fake, fakeGitHub, installation, normalize } from './test/fake-github.js';
import { identities } from '../github/identities.js';

const TALOS = 900;
const WHO = identities({});
const sha = (c: string): string => c.repeat(40);
const V1 = { tag: 'v1.0.0', sha: sha('1'), date: '2026-10-01T00:00:00Z' };
const V2 = { tag: 'v1.1.0', sha: sha('2'), date: '2026-10-08T00:00:00Z' };
const V3 = { tag: 'v1.2.0', sha: sha('3'), date: '2026-10-14T00:00:00Z' };
const NOW = new Date('2026-10-23T12:00:00Z');

const key = (path: string): string => normalize(`https://x.test/${path}`);
const CREATED = encodeURIComponent('>=2026-10-14T00:00:00Z');

type Scenario = {
  readonly tags: readonly (typeof V1)[];
  readonly pins: Readonly<Record<string, string | undefined>>;
  readonly regressions?: readonly object[];
  readonly history?: readonly { readonly at: string; readonly sha: string }[];
  readonly jobs?: readonly { readonly name: string; readonly conclusion: string }[];
};

const gateRule = (pin: string | undefined) => ({
  type: 'workflows',
  parameters: {
    workflows: [
      { path: '.github/workflows/gate.yml', repository_id: TALOS, ...(pin ? { sha: pin } : {}) },
    ],
  },
});

type Fakes = { talos: Fake; release: Fake; canary: Fake };

function setUp(scenario: Scenario): Fakes {
  const talos = fakeGitHub({
    'GET repos/SVP-Labs/Talos': {
      body: { id: TALOS, full_name: 'SVP-Labs/Talos', default_branch: 'main' },
    },
    'POST graphql': {
      body: {
        data: {
          repository: {
            refs: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: scenario.tags.map((t) => ({
                name: t.tag,
                target: { __typename: 'Commit', oid: t.sha, committedDate: t.date },
              })),
            },
          },
        },
      },
    },
    'GET repos/SVP-Labs/Talos/issues?state=all&labels=regression': {
      body: scenario.regressions ?? [],
    },
    'GET repos/SVP-Labs/Talos/issues/5/events': { body: [] },
  });
  for (const tag of scenario.tags) {
    talos.on('GET', `repos/SVP-Labs/Talos/compare/${tag.sha}...main`, {
      body: { status: 'ahead' },
    });
  }
  const release = fakeGitHub({
    'GET orgs/SVP-Labs/rulesets': {
      body: Object.keys(scenario.pins).map((channel, index) => ({
        id: index + 1,
        name: `talos-${channel}`,
      })),
    },
  });
  const canary = fakeGitHub({
    'GET installation/repositories': installation([
      { id: 1, name: 'SVP-Labs/Talos', private: false, talos: 'canary' },
      { id: 2, name: 'SVP-Labs/Thea', talos: 'canary' },
    ]),
  });
  for (const [index, [channel, pin]] of Object.entries(scenario.pins).entries()) {
    const id = index + 1;
    release.on('GET', `orgs/SVP-Labs/rulesets/${id}`, {
      body: { id, name: `talos-${channel}`, enforcement: 'active', rules: [gateRule(pin)] },
    });
    release.on('PUT', `orgs/SVP-Labs/rulesets/${id}`, { body: {} });
  }
  const history = scenario.history ?? [];
  release.on('GET', 'orgs/SVP-Labs/rulesets/2/history', {
    body: history.map((h, i) => ({ version_id: i + 1, updated_at: h.at })),
  });
  for (const [i, h] of history.entries()) {
    release.on('GET', `orgs/SVP-Labs/rulesets/2/history/${i + 1}`, {
      body: { version_id: i + 1, updated_at: h.at, state: { rules: [gateRule(h.sha)] } },
    });
  }
  const runs = {
    body: {
      total_count: 2,
      workflow_runs: [
        { id: 11, event: 'pull_request' },
        { id: 12, event: 'schedule' },
      ],
    },
  };
  for (const repo of ['SVP-Labs/Talos', 'SVP-Labs/Thea']) {
    canary.on('GET', key(`repos/${repo}/actions/runs?status=completed&created=${CREATED}`), runs);
    canary.on('GET', `repos/${repo}/actions/runs/11/jobs?filter=latest`, {
      body: {
        total_count: 1,
        jobs: (scenario.jobs ?? []).map((job, i) => ({
          id: i,
          run_id: 11,
          name: job.name,
          status: 'completed',
          conclusion: job.conclusion,
        })),
      },
    });
  }
  return { talos, release, canary };
}

function deps(fakes: Fakes, extra: Partial<ChannelsDeps> = {}): ChannelsDeps {
  return {
    talos: fakes.talos.gh,
    release: fakes.release.gh,
    canary: fakes.canary.gh,
    mirror: undefined,
    who: WHO,
    now: NOW,
    urgent: false,
    ...extra,
  };
}

function puts(fake: Fake): [string, string | undefined][] {
  return fake.calls
    .filter((c) => c.method === 'PUT')
    .map((c) => {
      const body = c.body as { rules: { parameters: { workflows: { sha?: string }[] } }[] };
      return [c.path, body.rules[0]?.parameters.workflows[0]?.sha];
    });
}

const CLEAN_RUNS = [
  { name: 'verdict (talos 1.2.0)', conclusion: 'failure' },
  { name: 'engine (talos 1.2.0)', conclusion: 'success' },
  { name: 'verdict (talos 1.2.0)', conclusion: 'success' },
  { name: 'verdict (talos 1.2.0)', conclusion: 'success' },
];

describe('runChannels', () => {
  it('seeds every pin from the first release', async () => {
    const fakes = setUp({
      tags: [V1],
      pins: { evaluate: undefined, canary: undefined, stable: undefined },
    });
    const report = await runChannels(deps(fakes));
    expect(puts(fakes.release)).toEqual([
      ['orgs/SVP-Labs/rulesets/2', V1.sha],
      ['orgs/SVP-Labs/rulesets/3', V1.sha],
      ['orgs/SVP-Labs/rulesets/1', V1.sha],
    ]);
    expect(report).toMatchObject({
      pins: { evaluate: 'v1.0.0', canary: 'v1.0.0', stable: 'v1.0.0' },
      moved: 3,
      promotion: 'canary-moved',
      missing: 0,
    });
  });

  it('moves canary to a new release and promotes nothing in the same run', async () => {
    const fakes = setUp({
      tags: [V2, V1],
      pins: { evaluate: V1.sha, canary: V1.sha, stable: V1.sha },
    });
    const report = await runChannels(deps(fakes));
    expect(puts(fakes.release)).toEqual([['orgs/SVP-Labs/rulesets/2', V2.sha]]);
    expect(report).toMatchObject({ moved: 1, promotion: 'canary-moved', gateRuns: null });
  });

  it("promotes canary's release after seven days and five clean gate runs", async () => {
    const fakes = setUp({
      tags: [V3, V2],
      pins: { evaluate: V2.sha, canary: V3.sha, stable: V2.sha },
      history: [
        { at: '2026-10-15T00:00:00Z', sha: V3.sha },
        { at: '2026-10-08T00:00:00Z', sha: V2.sha },
      ],
      jobs: CLEAN_RUNS,
    });
    const report = await runChannels(deps(fakes));
    expect(puts(fakes.release)).toEqual([
      ['orgs/SVP-Labs/rulesets/3', V3.sha],
      ['orgs/SVP-Labs/rulesets/1', V3.sha],
    ]);
    expect(report).toMatchObject({
      pins: { evaluate: 'v1.2.0', canary: 'v1.2.0', stable: 'v1.2.0' },
      moved: 2,
      promotion: 'promoted',
      gateRuns: 6,
      engineErrors: 0,
    });
    expect(fakes.release.calls.filter((c) => !c.path.startsWith('orgs/'))).toEqual([]);
  });

  it('counts no gate run when no repository is on canary', async () => {
    const fakes = setUp({
      tags: [V3, V2],
      pins: { evaluate: V2.sha, canary: V3.sha, stable: V2.sha },
      history: [{ at: '2026-10-15T00:00:00Z', sha: V3.sha }],
      jobs: CLEAN_RUNS,
    });
    expect(await runChannels(deps(fakes, { canary: undefined }))).toMatchObject({
      moved: 0,
      gateRuns: 0,
      engineErrors: 0,
    });
  });

  it('holds a young release without counting its runs', async () => {
    const fakes = setUp({
      tags: [V3, V2],
      pins: { evaluate: V2.sha, canary: V3.sha, stable: V2.sha },
      history: [{ at: '2026-10-20T00:00:00Z', sha: V3.sha }],
      jobs: CLEAN_RUNS,
    });
    expect(await runChannels(deps(fakes))).toMatchObject({
      moved: 0,
      promotion: 'too-young',
      gateRuns: null,
    });
    expect(fakes.canary.calls).toEqual([]);
  });

  it('holds a release with an engine error under it', async () => {
    const fakes = setUp({
      tags: [V3, V2],
      pins: { evaluate: V2.sha, canary: V3.sha, stable: V2.sha },
      history: [{ at: '2026-10-15T00:00:00Z', sha: V3.sha }],
      jobs: [...CLEAN_RUNS, { name: 'engine (talos 1.2.0)', conclusion: 'failure' }],
    });
    expect(await runChannels(deps(fakes))).toMatchObject({
      moved: 0,
      promotion: 'engine-error',
      engineErrors: 1,
    });
  });

  it('promotes on the urgent path after one clean run, without reading the history', async () => {
    const fakes = setUp({
      tags: [V3, V2],
      pins: { evaluate: V2.sha, canary: V3.sha, stable: V2.sha },
      jobs: [{ name: 'verdict (talos 1.2.0)', conclusion: 'success' }],
    });
    const report = await runChannels(deps(fakes, { urgent: true }));
    expect(report).toMatchObject({ promotion: 'promoted', moved: 2 });
    expect(fakes.release.calls.some((c) => c.path.includes('history'))).toBe(false);
  });

  it('rolls canary back when a trusted regression is open, and holds promotion', async () => {
    const fakes = setUp({
      tags: [V3, V2],
      pins: { evaluate: V2.sha, canary: V3.sha, stable: V2.sha },
      regressions: [
        {
          number: 5,
          title: 'v1.2.0 broke the gate',
          state: 'open',
          labels: [{ name: 'regression' }],
          user: { login: 'SvenPGH' },
          created_at: '2026-10-20T00:00:00Z',
        },
      ],
    });
    const report = await runChannels(deps(fakes));
    expect(puts(fakes.release)).toEqual([['orgs/SVP-Labs/rulesets/2', V2.sha]]);
    expect(report).toMatchObject({
      pins: { canary: 'v1.1.0' },
      regressions: 1,
      promotion: 'canary-moved',
    });
  });

  it('reports a channel without a ruleset and still moves the rest', async () => {
    const fakes = setUp({ tags: [V2, V1], pins: { canary: V1.sha, stable: V1.sha } });
    const report = await runChannels(deps(fakes));
    expect(puts(fakes.release)).toEqual([['orgs/SVP-Labs/rulesets/1', V2.sha]]);
    expect(report).toMatchObject({ missing: 1, moved: 1 });
  });

  it("mirrors the pins to channels.json in the fallback lookup, with the mirror's token", async () => {
    const fakes = setUp({
      tags: [V2, V1],
      pins: { evaluate: V1.sha, canary: V1.sha, stable: V1.sha },
    });
    const mirror = fakeGitHub({
      'GET repos/SVP-Labs/Talos/git/ref/heads/channels': { body: { object: { sha: 'x' } } },
      'PUT repos/SVP-Labs/Talos/contents/channels.json': { body: {} },
    });
    await runChannels(deps(fakes, { mirror: mirror.gh }));
    expect(fakes.release.calls.filter((c) => !c.path.startsWith('orgs/'))).toEqual([]);
    const write = mirror.calls.find(
      (c) => c.path === 'repos/SVP-Labs/Talos/contents/channels.json',
    );
    const content = (write?.body as { content: string }).content;
    expect(Buffer.from(content, 'base64').toString('utf8')).toBe(
      channelsText({ evaluate: V1.sha, canary: V2.sha, stable: V1.sha }),
    );
  });
});

describe('mergeMoves', () => {
  it('keeps the last move of each channel, canary first', () => {
    const r = (tag: string) => ({ tag, version: tag, sha: tag, taggedAt: '' });
    expect(
      mergeMoves([
        { channel: 'evaluate', from: undefined, to: r('a') },
        { channel: 'stable', from: undefined, to: r('b') },
        { channel: 'evaluate', from: undefined, to: r('b') },
        { channel: 'canary', from: undefined, to: r('c') },
      ]).map((m) => [m.channel, m.to.tag]),
    ).toEqual([
      ['canary', 'c'],
      ['stable', 'b'],
      ['evaluate', 'b'],
    ]);
  });
});

describe('the gate runs on canary', () => {
  it('finds the canary repositories the token reaches', async () => {
    const fake = fakeGitHub({
      'GET installation/repositories': installation([
        { id: 1, name: 'o/a', talos: 'canary' },
        { id: 2, name: 'o/b', talos: 'canary', archived: true },
        { id: 3, name: 'o/c', talos: 'stable' },
        { id: 4, name: 'o/d' },
      ]),
    });
    expect(await canaryRepositories(fake.gh)).toEqual(['o/a']);
  });

  it('stops counting at the first engine error', async () => {
    const fakes = setUp({
      tags: [V3],
      pins: {},
      jobs: [{ name: 'engine (talos 1.2.0)', conclusion: 'failure' }],
    });
    const tally = await tallyGateRuns(
      fakes.canary.gh,
      ['SVP-Labs/Talos', 'SVP-Labs/Thea'],
      '1.2.0',
      V3.date,
    );
    expect(tally).toEqual({ runs: 0, engineErrors: 1 });
    expect(fakes.canary.calls.filter((c) => c.path.endsWith('/jobs?filter=latest'))).toHaveLength(
      1,
    );
  });
});
