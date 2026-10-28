import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { channelsText } from './channels-file.js';
import { expectedFromAssets, runChannelsFileDrift, runDrift } from './drift-job.js';
import { driftMarker, GOVERNED_SETTINGS } from './drift.js';
import { type Fake, fakeGitHub, installation } from './test/fake-github.js';
import { identities } from '../github/identities.js';

const WHO = identities({});
const ASSETS = new URL('../../assets/', import.meta.url);
const R = 'repos/SVP-Labs/Secret';
const REVIEWER_APP_ID = 5465977;

const file = (text: string) => ({
  body: {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(text).toString('base64'),
    sha: 's',
  },
});

const created = (body: unknown) => ({
  status: 201,
  body: {
    number: 50,
    title: 't',
    state: 'open',
    labels: (body as { labels: string[] }).labels.map((name) => ({ name })),
    created_at: 'now',
  },
});

async function governed(talos = 'stable'): Promise<{ release: Fake; reviewer: Fake }> {
  const expected = await expectedFromAssets('SvenPGH', REVIEWER_APP_ID, ASSETS);
  const queue = JSON.parse(
    await readFile(new URL('rulesets/merge-queue.json', ASSETS), 'utf8'),
  ) as object;
  const repos = installation([{ id: 7, name: 'SVP-Labs/Secret', talos }]);
  const release = fakeGitHub({
    'GET installation/repositories': repos,
    [`GET ${R}`]: { body: { id: 7, ...GOVERNED_SETTINGS, allow_squash_merge: true } },
    [`GET ${R}/vulnerability-alerts`]: { status: 204 },
    [`GET ${R}/rulesets?includes_parents=false`]: {
      body: [
        { id: 1, name: 'talos-merge-queue' },
        { id: 2, name: 'unrelated' },
      ],
    },
    [`GET ${R}/rulesets/1`]: { body: { id: 1, ...queue, source_type: 'Repository' } },
  });
  const reviewer = fakeGitHub({
    'GET installation/repositories': repos,
    [`GET ${R}/contents/.github/workflows/talos.yml?ref=main`]: file(expected.caller),
    [`GET ${R}/contents/CODEOWNERS?ref=main`]: file(expected.codeowners),
    [`GET ${R}/issues?state=open&labels=drift`]: {
      body: [
        {
          number: 3,
          title: 'Drift: Dependabot alerts',
          body: `${driftMarker('alerts')}\n`,
          state: 'open',
          labels: [{ name: 'drift' }],
          user: { login: 'talos-reviewer[bot]' },
          created_at: 'then',
        },
      ],
    },
    [`POST ${R}/issues`]: created,
    [`PATCH ${R}/issues/3`]: { body: {} },
  });
  return { release, reviewer };
}

describe('expectedFromAssets', () => {
  it('reads the caller, CODEOWNERS for the owner and the merge queue Talos ships', async () => {
    const expected = await expectedFromAssets('SvenPGH', REVIEWER_APP_ID, ASSETS);
    expect(expected.caller).toBe(await readFile(new URL('workflows/talos.yml', ASSETS), 'utf8'));
    expect(expected.codeowners).toContain('* @SvenPGH');
    expect(expected.codeowners).not.toContain('@OWNER');
    expect(expected.mergeQueue).toMatchObject({ name: 'talos-merge-queue' });
    expect(expected.ownerReview).toMatchObject({
      name: 'talos-owner-review',
      bypass_actors: [],
      rules: [
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [{ context: 'talos/review', integration_id: REVIEWER_APP_ID }],
          },
        },
      ],
    });
    expect(expected.settings).toBe(GOVERNED_SETTINGS);
  });
});

describe('runDrift', () => {
  it('files one issue per new difference and closes the ones that are gone', async () => {
    const { release, reviewer } = await governed();
    const report = await runDrift({
      release: release.gh,
      reviewer: reviewer.gh,
      who: WHO,
      expected: await expectedFromAssets('SvenPGH', REVIEWER_APP_ID, ASSETS),
    });
    expect(report).toEqual({ governed: 1, differences: 1, filed: 1, closed: 1 });
    const post = reviewer.calls.find((c) => c.method === 'POST');
    expect((post?.body as { body: string }).body.split('\n')[0]).toBe(
      driftMarker('setting:allow_squash_merge'),
    );
    expect(reviewer.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      state: 'closed',
      state_reason: 'completed',
    });
    expect(release.calls.every((c) => c.method === 'GET')).toBe(true);
    expect([...release.unmatched, ...reviewer.unmatched]).toEqual([
      `GET ${R}/contents/.github/CODEOWNERS?ref=main`,
    ]);
  });

  it('leaves an ungoverned repository alone', async () => {
    const { release, reviewer } = await governed('');
    const report = await runDrift({
      release: release.gh,
      reviewer: reviewer.gh,
      who: WHO,
      expected: await expectedFromAssets('SvenPGH', REVIEWER_APP_ID, ASSETS),
    });
    expect(report).toEqual({ governed: 0, differences: 0, filed: 0, closed: 0 });
  });

  it('refuses two tokens that reach different repositories', async () => {
    const { release } = await governed();
    const other = fakeGitHub({
      'GET installation/repositories': installation([{ id: 8, name: 'o/x' }]),
    });
    await expect(
      runDrift({
        release: release.gh,
        reviewer: other.gh,
        who: WHO,
        expected: await expectedFromAssets('SvenPGH', REVIEWER_APP_ID, ASSETS),
      }),
    ).rejects.toThrow('different repositories');
  });

  it('reads Dependabot alerts as off on 404 and unknown on any other failure', async () => {
    const { release, reviewer } = await governed();
    release.on('GET', `${R}/vulnerability-alerts`, { status: 404 });
    const expected = await expectedFromAssets('SvenPGH', REVIEWER_APP_ID, ASSETS);
    const off = await runDrift({ release: release.gh, reviewer: reviewer.gh, who: WHO, expected });
    expect(off.differences).toBe(2);
    release.on('GET', `${R}/vulnerability-alerts`, { status: 403 });
    const unknown = await runDrift({
      release: release.gh,
      reviewer: reviewer.gh,
      who: WHO,
      expected,
    });
    expect(unknown.differences).toBe(1);
  });
});

describe('runDrift at evaluate', () => {
  async function atEvaluate(ownerReview: unknown) {
    const { release, reviewer } = await governed('evaluate');
    release.on('GET', `${R}/rulesets?includes_parents=false`, {
      body: [
        { id: 1, name: 'talos-merge-queue' },
        { id: 4, name: 'talos-owner-review' },
      ],
    });
    release.on('GET', `${R}/rulesets/4`, { body: { id: 4, ...(ownerReview as object) } });
    const expected = await expectedFromAssets('SvenPGH', REVIEWER_APP_ID, ASSETS);
    await runDrift({ release: release.gh, reviewer: reviewer.gh, who: WHO, expected });
    return reviewer.calls
      .filter((c) => c.method === 'POST')
      .map((c) => (c.body as { body: string }).body.split('\n')[0]);
  }

  it('accepts the owner rule as govern writes it, and reports the older code-owner rule', async () => {
    const current = (await expectedFromAssets('SvenPGH', REVIEWER_APP_ID, ASSETS)).ownerReview;
    expect(await atEvaluate(current)).toEqual([driftMarker('setting:allow_squash_merge')]);
    const older = {
      ...(current as object),
      bypass_actors: [
        { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' },
      ],
      rules: [{ type: 'pull_request', parameters: { require_code_owner_review: true } }],
    };
    expect(await atEvaluate(older)).toEqual([
      driftMarker('setting:allow_squash_merge'),
      driftMarker('ruleset:talos-owner-review'),
    ]);
  });
});

describe('runChannelsFileDrift', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const rule = (sha: string) => ({
    type: 'workflows',
    parameters: { workflows: [{ path: '.github/workflows/gate.yml', repository_id: 900, sha }] },
  });

  function setUp(text: string | undefined): { release: Fake; reviewer: Fake } {
    const release = fakeGitHub({
      'GET repos/SVP-Labs/Talos': { body: { id: 900, full_name: 'SVP-Labs/Talos' } },
      'GET orgs/SVP-Labs/rulesets': {
        body: [
          { id: 1, name: 'talos-evaluate' },
          { id: 2, name: 'talos-canary' },
          { id: 3, name: 'talos-stable' },
        ],
      },
      'GET orgs/SVP-Labs/rulesets/1': {
        body: { id: 1, name: 'talos-evaluate', enforcement: 'evaluate', rules: [rule(A)] },
      },
      'GET orgs/SVP-Labs/rulesets/2': {
        body: { id: 2, name: 'talos-canary', enforcement: 'active', rules: [rule(B)] },
      },
      'GET orgs/SVP-Labs/rulesets/3': {
        body: { id: 3, name: 'talos-stable', enforcement: 'active', rules: [rule(A)] },
      },
    });
    const reviewer = fakeGitHub({
      'GET repos/SVP-Labs/Talos/issues?state=open&labels=drift': {
        body: [
          {
            number: 9,
            title: 'Drift: caller',
            body: `${driftMarker('file:caller')}\n`,
            state: 'open',
            labels: [],
            user: { login: 'talos-reviewer[bot]' },
            created_at: 'then',
          },
        ],
      },
      'POST repos/SVP-Labs/Talos/issues': created,
    });
    if (text !== undefined) {
      reviewer.on('GET', 'repos/SVP-Labs/Talos/contents/channels.json?ref=channels', {
        body: { sha: 'x', encoding: 'base64', content: Buffer.from(text).toString('base64') },
      });
    }
    return { release, reviewer };
  }

  it('finds nothing when the file matches the rulesets', async () => {
    const { release, reviewer } = setUp(channelsText({ evaluate: A, canary: B, stable: A }));
    expect(
      await runChannelsFileDrift({ release: release.gh, reviewer: reviewer.gh, who: WHO }),
    ).toEqual({
      governed: 1,
      differences: 0,
      filed: 0,
      closed: 0,
    });
  });

  it("files one issue per wrong channel in Talos, leaving the repository's own drift alone", async () => {
    const { release, reviewer } = setUp(channelsText({ evaluate: A, canary: A, stable: A }));
    const report = await runChannelsFileDrift({
      release: release.gh,
      reviewer: reviewer.gh,
      who: WHO,
    });
    expect(report).toEqual({ governed: 1, differences: 1, filed: 1, closed: 0 });
    const missing = setUp(undefined);
    const all = await runChannelsFileDrift({
      release: missing.release.gh,
      reviewer: missing.reviewer.gh,
      who: WHO,
    });
    expect(all.differences).toBe(3);
  });
});
