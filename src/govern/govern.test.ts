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
  const failing = () =>
    fakeApi([
      route('PUT', /vulnerability-alerts$/, {
        status: 403,
        json: { message: 'Must have admin rights', documentation_url: 'https://docs', x: 'raw' },
      }),
      route('PATCH', /properties\/values$/, json({})),
    ]);
  const steps = [
    ok('a', 'fine'),
    change('alerts', 'switch on alerts', { kind: 'enable-alerts', repo: REPO }),
    change('p', 'set', { kind: 'set-properties', repo: REPO, values: [] }),
    manual('m', 'by hand'),
  ];

  it("stops at the first failure and says why in GitHub's words, not its raw body", async () => {
    const results = await applySteps(failing().client(), steps, { hint: scopeHint });
    expect(results.map((r) => r.status)).toEqual(['ok', 'failed', 'skipped', 'manual']);
    const request = `PUT repos/${REPO}/vulnerability-alerts`;
    expect(results[1]?.detail).toBe(
      `switch on alerts: ${request}: 403 (Must have admin rights)${scopeHint(403)}`,
    );
    expect(results[1]?.detail).not.toMatch(/docs|raw/);
    expect(planned(steps).map((r) => r.status)).toEqual(['ok', 'planned', 'planned', 'manual']);
  });

  it('runs every step past a failure when they are independent', async () => {
    const api = failing();
    const results = await applySteps(api.client(), steps, { independent: true });
    expect(results.map((r) => r.status)).toEqual(['ok', 'failed', 'changed', 'manual']);
    expect(api.writes()).toEqual([
      `PUT repos/${REPO}/vulnerability-alerts`,
      `PATCH repos/${REPO}/properties/values`,
    ]);
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
  it('leaves the repository to the owner where the token may not list an installation', async () => {
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
    const steps = installationSteps(states, { id: 42, name: REPO });
    expect(steps.map((s) => s.status)).toEqual(['manual', 'manual', 'manual']);
    expect(steps[0]?.detail).toBe(
      `add ${REPO} to thea-svp's installation if it isn't there: Org Settings → GitHub Apps → ` +
        'thea-svp → Configure → Repository access → add the repository → Save',
    );
  });

  it('turns a refused addition into that step by hand, and carries on past it', async () => {
    const installations = [
      { id: 1, app_slug: 'thea-svp', repository_selection: 'selected' },
      { id: 2, app_slug: 'talos-reviewer', repository_selection: 'selected' },
      { id: 3, app_slug: 'talos-release', repository_selection: 'all' },
    ];
    const api = fakeApi([
      route('GET', /^orgs\/SVP-Labs\/installations$/, json({ installations })),
      route('GET', /^user\/installations\/\d+\/repositories$/, json({ repositories: [] })),
      route('PUT', /^user\/installations\/1\/repositories\/42$/, {
        status: 403,
        json: { message: 'You do not have permission to modify this app on SVP-Labs' },
      }),
      route('PUT', /^user\/installations\/2\/repositories\/42$/, json({})),
    ]);
    const states = await readInstallations(api.client(), who, 42);
    const steps = installationSteps(states, { id: 42, name: REPO });
    expect(planned(steps).map((r) => r.status)).toEqual(['planned', 'planned', 'ok']);
    const results = await applySteps(api.client(), steps, { hint: scopeHint });
    expect(results.map((r) => r.status)).toEqual(['manual', 'changed', 'ok']);
    expect(results[0]?.detail).toMatch(/^add SVP-Labs\/demo to thea-svp's installation .* → Save$/);
  });

  it('reports any other refusal of an addition as a failure', async () => {
    const api = fakeApi([route('PUT', /^user\/installations\//, { status: 404, json: {} })]);
    const step = change(
      'app:x',
      'add',
      { kind: 'install', installationId: 1, repositoryId: 42 },
      'by hand',
    );
    expect((await applySteps(api.client(), [step])).map((r) => r.status)).toEqual(['failed']);
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
