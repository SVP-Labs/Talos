import { describe, expect, it } from 'vitest';
import { AdoptRefusal } from './config.js';
import { findBootstrap, legacyTargets, openBootstrapPull, startAdoption } from './remote.js';
import { ADOPT_MARKER } from './texts.js';
import { identities } from '../github/identities.js';
import {
  fakeApi,
  type FakeApi,
  json,
  NO_CONTENT,
  NOT_FOUND,
  route,
} from '../govern/test/fake-api.js';
import { parseIssues } from '../ticket/schemas.js';

const who = identities({});
const NOW = new Date('2026-10-23T10:00:00Z');

type Issue = { number: number; body: string; labels: string[]; user: string; pull?: boolean };

function issueJson(issue: Issue) {
  return {
    number: issue.number,
    title: `#${issue.number}`,
    body: issue.body,
    state: 'open',
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user },
    author_association: 'OWNER',
    created_at: '2026-10-01T00:00:00Z',
    ...(issue.pull === true ? { pull_request: { url: 'x' } } : {}),
  };
}

type World = {
  issues: Issue[];
  branches: Set<string>;
  comments: Map<number, string[]>;
  pulls: { number: number; head: string }[];
  ahead: number;
};

function api(world: World): FakeApi {
  const at = (suffix: string): RegExp => new RegExp(`^repos/SVP-Labs/demo${suffix}$`);
  return fakeApi([
    route('GET', at('/labels'), json([])),
    route('POST', at('/labels'), json({}, 201)),
    route('GET', at(''), json({ id: 1, default_branch: 'main' })),
    route(
      'GET',
      at('/git/ref/heads/main'),
      json({ ref: 'refs/heads/main', object: { sha: 'm'.repeat(40) } }),
    ),
    route('GET', at('/issues'), () => json(world.issues.map(issueJson))),
    route('POST', at('/issues'), (call) => {
      const body = call.body as { body: string; labels: string[] };
      const issue = { number: 20, body: body.body, labels: body.labels, user: 'thea-svp[bot]' };
      world.issues.push(issue);
      return json(issueJson(issue), 201);
    }),
    route('POST', at('/issues/(\\d+)/labels'), (call, m) => {
      const issue = world.issues.find((i) => i.number === Number(m[1]));
      issue?.labels.push(...(call.body as { labels: string[] }).labels);
      return json([]);
    }),
    route('GET', at('/issues/(\\d+)/comments'), (_c, m) =>
      json(
        (world.comments.get(Number(m[1])) ?? []).map((body, id) => ({
          id,
          body,
          user: { login: 'thea-svp[bot]' },
          created_at: '2026-10-23T10:00:00Z',
        })),
      ),
    ),
    route('POST', at('/issues/(\\d+)/comments'), (call, m) => {
      const list = world.comments.get(Number(m[1])) ?? [];
      list.push((call.body as { body: string }).body);
      world.comments.set(Number(m[1]), list);
      return json({ id: 1 }, 201);
    }),
    route('GET', at('/branches/(.+)'), (_c, m) =>
      world.branches.has(m[1] ?? '')
        ? json({
            commit: {
              sha: 'm'.repeat(40),
              commit: { committer: { date: '2026-10-23T10:00:00Z' } },
            },
          })
        : NOT_FOUND,
    ),
    route('POST', at('/git/refs'), (call) => {
      world.branches.add((call.body as { ref: string }).ref.replace('refs/heads/', ''));
      return json({}, 201);
    }),
    route('GET', at('/pulls'), (call) =>
      json(
        world.pulls
          .filter((p) => call.query.get('head') === `SVP-Labs:${p.head}`)
          .map((p) => ({
            number: p.number,
            state: 'open',
            updated_at: 'x',
            head: { ref: p.head },
          })),
      ),
    ),
    route('GET', at('/compare/main\\.\\.\\.(.+)'), (_c, m) =>
      world.branches.has(m[1] ?? '')
        ? json({ ahead_by: world.ahead, files: [{}, {}, {}] })
        : NOT_FOUND,
    ),
    route('POST', at('/pulls'), (call) => {
      world.pulls.push({ number: 21, head: (call.body as { head: string }).head });
      return json({ number: 21, html_url: 'https://github.com/SVP-Labs/demo/pull/21' }, 201);
    }),
    route('DELETE', at('/x'), NO_CONTENT),
  ]);
}

function world(issues: Issue[] = []): World {
  return { issues, branches: new Set(), comments: new Map(), pulls: [], ahead: 1 };
}

const OPTIONS = {
  name: 'Demo',
  brief: undefined,
  scaffold: false,
  prefix: 'D',
  agent: 'thea',
  now: NOW,
};

describe('startAdoption', () => {
  it('labels the repository, marks the old backlog legacy, then files and claims issue #1', async () => {
    const w = world([
      { number: 3, body: 'old', labels: [], user: 'someone' },
      { number: 4, body: 'older', labels: ['legacy'], user: 'someone' },
      { number: 5, body: 'a PR', labels: [], user: 'someone', pull: true },
    ]);
    const fake = api(w);
    const result = await startAdoption(fake.client(), 'SVP-Labs/demo', who, OPTIONS);
    expect(result).toMatchObject({ issue: 20, branch: 'D-20', filed: true, legacy: 1 });
    expect(result.labels.created).toBeGreaterThan(20);
    expect(w.issues.find((i) => i.number === 3)?.labels).toEqual(['legacy']);
    expect(w.issues.find((i) => i.number === 20)?.labels).toEqual([
      'chore',
      'status/in-progress',
      'ai/claimed',
    ]);
    expect(w.branches).toEqual(new Set(['D-20']));
    expect(w.comments.get(20)).toEqual(['🔒 claimed by thea · 2026-10-23T10:00:00Z']);
    const legacyCall = fake.writes().indexOf('POST repos/SVP-Labs/demo/issues/3/labels');
    expect(legacyCall).toBeLessThan(fake.writes().indexOf('POST repos/SVP-Labs/demo/issues'));
  });

  it('finds its own issue again on a rerun and changes nothing more', async () => {
    const w = world([]);
    await startAdoption(api(w).client(), 'SVP-Labs/demo', who, OPTIONS);
    const fake = api(w);
    const again = await startAdoption(fake.client(), 'SVP-Labs/demo', who, OPTIONS);
    expect(again).toMatchObject({ issue: 20, filed: false, legacy: 0 });
    expect(fake.writes().filter((w) => !w.includes('/labels'))).toEqual([]);
  });

  it('refuses to write the approval marker', async () => {
    const w = world([]);
    await expect(
      startAdoption(api(w).client(), 'SVP-Labs/demo', who, { ...OPTIONS, name: 'talos-approve' }),
    ).rejects.toThrow(AdoptRefusal);
  });
});

describe('findBootstrap and legacyTargets', () => {
  it('trusts the marker only from the owner or Thea', () => {
    const issues = parseIssues([
      issueJson({ number: 1, body: ADOPT_MARKER, labels: [], user: 'stranger' }),
      issueJson({ number: 2, body: ADOPT_MARKER, labels: [], user: 'SvenPGH' }),
    ]);
    expect(findBootstrap(issues, who)?.number).toBe(2);
    expect(legacyTargets(issues, 2)).toEqual([1]);
  });
});

describe('openBootstrapPull', () => {
  const PULL = { name: 'Demo', brief: undefined, scaffold: false, prefix: 'D', issue: 20 };

  it('opens the PR once the branch has the adoption, and finds it again after', async () => {
    const w = world([]);
    w.branches.add('D-20');
    const fake = api(w);
    expect(await openBootstrapPull(fake.client(), 'SVP-Labs/demo', PULL)).toEqual({
      pr: 21,
      opened: true,
    });
    const body = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))?.body;
    expect(body).toMatchObject({
      title: '[D-20]: Bring Demo under Talos',
      head: 'D-20',
      base: 'main',
      draft: false,
    });
    expect(await openBootstrapPull(api(w).client(), 'SVP-Labs/demo', PULL)).toEqual({
      pr: 21,
      opened: false,
    });
  });

  it('refuses before the adoption is pushed', async () => {
    const w = world([]);
    await expect(openBootstrapPull(api(w).client(), 'SVP-Labs/demo', PULL)).rejects.toThrow(
      /push the adoption/,
    );
    w.branches.add('D-20');
    w.ahead = 0;
    await expect(openBootstrapPull(api(w).client(), 'SVP-Labs/demo', PULL)).rejects.toThrow(
      AdoptRefusal,
    );
  });
});
