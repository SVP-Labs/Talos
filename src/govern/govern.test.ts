import { beforeAll, describe, expect, it } from 'vitest';
import { commitFiles } from './commit.js';
import {
  assertOwner,
  type GovernAssets,
  governJson,
  governRepository,
  loadGovernAssets,
} from './govern.js';
import { installationSteps, readInstallations } from './installations.js';
import { GovernRefusal } from './plan.js';
import { readRepoState } from './state.js';
import { applySteps, change, manual, ok, planned, scopeHint } from './steps.js';
import { loadTemplates } from './templates.js';
import { fakeApi, type FakeApi, json, route } from './test/fake-api.js';
import { freshWorld, worldApi } from './test/world.js';
import { identities } from '../github/identities.js';

const who = identities({});
const REPO = 'SVP-Labs/demo';
const HEAD = 'c'.repeat(40);

let assets: GovernAssets;
beforeAll(async () => {
  assets = {
    caller: 'name: talos\n',
    codeowners: (await loadGovernAssets().catch(() => undefined))?.codeowners ?? '* @OWNER\n',
    templates: await loadTemplates(),
  };
});

function options(api: FakeApi, overrides: Partial<Parameters<typeof governRepository>[0]> = {}) {
  return {
    gh: api.client(),
    who,
    repo: REPO,
    agents: true,
    channel: undefined,
    dryRun: false,
    assets,
    ...overrides,
  };
}

describe('governRepository', () => {
  it('governs a fresh repository, and a rerun changes nothing', async () => {
    const world = freshWorld();
    const api = worldApi(world);
    const report = await governRepository(options(api));
    expect(report.results.filter((r) => r.status === 'failed')).toEqual([]);
    expect(api.writes()).toEqual([
      'GRAPHQL',
      `PATCH repos/${REPO}`,
      `POST repos/${REPO}/rulesets`,
      `POST repos/${REPO}/rulesets`,
      `PUT repos/${REPO}/vulnerability-alerts`,
      `PATCH repos/${REPO}/properties/values`,
      'PUT user/installations/1/repositories/42',
      'PUT user/installations/2/repositories/42',
    ]);
    expect(world.files.get('.github/workflows/talos.yml')).toBe('name: talos\n');
    expect(world.files.get('.github/CODEOWNERS')).toContain('* @SvenPGH');
    expect(world.files.has('.github/workflows/gates.yml')).toBe(false);
    expect(Object.fromEntries(world.properties)).toEqual({
      talos: 'evaluate',
      'talos-agents': 'true',
    });

    const again = worldApi(world);
    const rerun = await governRepository(options(again, { agents: undefined }));
    expect(again.writes()).toEqual([]);
    expect(governJson(rerun)).toMatchObject({ ok: true, channel: 'evaluate' });
  });

  it('moves a governed repository to canary and drops the owner rule', async () => {
    const world = freshWorld();
    await governRepository(options(worldApi(world)));
    const api = worldApi(world);
    const report = await governRepository(options(api, { channel: 'canary' }));
    expect(report.channel).toBe('canary');
    expect(api.writes()).toEqual([
      `PATCH repos/${REPO}/properties/values`,
      expect.stringMatching(new RegExp(`^DELETE repos/${REPO}/rulesets/\\d+$`)),
    ]);
    expect([...world.rulesets.values()].map((r) => r.name)).toEqual(['talos-merge-queue']);
  });

  it('plans without touching anything on a dry run', async () => {
    const api = worldApi(freshWorld());
    const report = await governRepository(options(api, { dryRun: true }));
    expect(api.writes()).toEqual([]);
    expect(report.results.map((r) => r.status)).toContain('planned');
  });

  it('refuses a token that is not the owner', async () => {
    await expect(
      assertOwner(worldApi(freshWorld(), 'thea-svp[bot]').client(), who),
    ).rejects.toThrow(GovernRefusal);
    const app = fakeApi([route('GET', /^user$/, { status: 403, json: {} })]);
    await expect(assertOwner(app.client(), who)).rejects.toThrow(/not a user/);
  });

  it('reads the state GitHub reports', async () => {
    const world = freshWorld();
    world.alerts = true;
    world.properties.set('talos', 'canary');
    const state = await readRepoState(worldApi(world).client(), REPO, who, {
      extraPaths: ['talos.yml'],
    });
    expect(state).toMatchObject({
      id: 42,
      head: HEAD,
      alerts: true,
      caller: undefined,
      extra: { 'talos.yml': undefined },
      properties: { talos: 'canary' },
    });
    expect(state.workflows.map((w) => w.path)).toEqual(['.github/workflows/gates.yml']);
    expect(state.installations.map((i) => i.member)).toEqual([false, false, true]);
    const drift = await readRepoState(worldApi(world).client(), REPO, who, {
      installations: false,
    });
    expect(drift.installations).toEqual([]);
  });
});

describe('applySteps', () => {
  it('stops at the first failure and says why without a response body', async () => {
    const api = fakeApi([
      route('PUT', /vulnerability-alerts$/, { status: 403, json: { message: 'secret' } }),
    ]);
    const steps = [
      ok('a', 'fine'),
      change('alerts', 'switch on alerts', { kind: 'enable-alerts', repo: REPO }),
      change('p', 'set', { kind: 'set-properties', repo: REPO, values: [] }),
      manual('m', 'by hand'),
    ];
    const results = await applySteps(api.client(), steps, scopeHint);
    expect(results.map((r) => r.status)).toEqual(['ok', 'failed', 'skipped', 'manual']);
    expect(results[1]?.detail).toMatch(/403.*gh auth refresh/);
    expect(results[1]?.detail).not.toMatch(/secret/);
    expect(planned(steps).map((r) => r.status)).toEqual(['ok', 'planned', 'planned', 'manual']);
  });

  it('defines org properties and updates org rulesets where GitHub expects them', async () => {
    const api = fakeApi([
      route('PUT', /^orgs\/SVP-Labs\/properties\/schema\/talos$/, json({})),
      route('PUT', /^orgs\/SVP-Labs\/rulesets\/5$/, json({ id: 5 })),
    ]);
    const body = (await loadTemplates()).mergeQueue;
    const results = await applySteps(api.client(), [
      change('p', 'define', { kind: 'define-property', org: 'SVP-Labs', name: 'talos', body: {} }),
      change('r', 'update', {
        kind: 'update-ruleset',
        scope: { kind: 'org', org: 'SVP-Labs' },
        id: 5,
        body,
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['changed', 'changed']);
    expect(scopeHint(500)).toBe('');
    expect(scopeHint(200)).toMatch(/workflow scope/);
  });
});

describe('readInstallations', () => {
  it('cannot tell membership when the token may not list an installation, and adds it', async () => {
    const api = fakeApi([
      route(
        'GET',
        /^orgs\/SVP-Labs\/installations$/,
        json({
          installations: [{ id: 1, app_slug: 'thea-svp', repository_selection: 'selected' }],
        }),
      ),
      route('GET', /^user\/installations\/1\/repositories$/, { status: 403, json: {} }),
    ]);
    const states = await readInstallations(api.client(), who, 42);
    expect(states.map((s) => [s.slug, s.member])).toEqual([
      ['thea-svp', undefined],
      ['talos-reviewer', false],
      ['talos-release', false],
    ]);
    expect(installationSteps(states, 42).map((s) => s.status)).toEqual([
      'change',
      'manual',
      'manual',
    ]);
  });
});

describe('commitFiles', () => {
  it('sends one signed commit with additions and deletions, a subject without a body', async () => {
    const api = fakeApi([
      route(
        'POST',
        /^graphql$/,
        json({ data: { createCommitOnBranch: { commit: { oid: 'abc' } } } }),
      ),
    ]);
    const oid = await commitFiles(api.client(), REPO, {
      branch: 'main',
      expectedHead: HEAD,
      message: 'Subject only',
      additions: [{ path: 'a.txt', contents: 'é' }],
      deletions: ['b.txt'],
    });
    expect(oid).toBe('abc');
    expect(api.calls[0]?.body).toMatchObject({
      variables: {
        input: {
          branch: { repositoryNameWithOwner: REPO, branchName: 'main' },
          message: { headline: 'Subject only' },
          expectedHeadOid: HEAD,
          fileChanges: {
            additions: [{ path: 'a.txt', contents: 'w6k=' }],
            deletions: [{ path: 'b.txt' }],
          },
        },
      },
    });
  });

  it('reports a failure that is not an API error by its message', async () => {
    const api = fakeApi([route('POST', /^graphql$/, json({ data: {} }))]);
    const changes = {
      branch: 'main',
      expectedHead: HEAD,
      message: 'x',
      additions: [],
      deletions: [],
    };
    const results = await applySteps(api.client(), [
      change('files', 'commit', { kind: 'commit', repo: REPO, changes }),
    ]);
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.detail).toMatch(/^commit: /);
  });
});
