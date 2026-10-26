import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildStatus,
  claimedBranches,
  gateState,
  issueOf,
  reviewState,
  type StatusInput,
} from './build.js';
import { orgStatus, repoStatus, statusContext, statusOf } from './collect.js';
import { loginOf, markerFields, priorityOf, reviewerVerdict } from './markers.js';
import { type ClaimComment, claimsQuery, type State, STATE_QUERY, type Suite } from './query.js';
import {
  clip,
  MAX_LISTED,
  type RepoStatus,
  type Status,
  statusJsonSchema,
  statusSchema,
} from './schema.js';
import { statusText } from './text.js';
import type { GitHub } from '../github/api.js';
import { identities } from '../github/identities.js';
import type { Pin } from '../version/pin.js';

const who = identities({});
const MAIN = '1'.repeat(40);
const PIN = 'a'.repeat(40);
const GATE_PATH = '.github/workflows/gate.yml';

function suite(overrides: Partial<Suite> = {}): Suite {
  return {
    createdAt: '2026-10-23T10:00:00Z',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    app: { slug: 'github-actions' },
    workflowRun: { file: { path: GATE_PATH, repositoryName: 'SVP-Labs/Talos' } },
    review: { nodes: [] },
    ...overrides,
  };
}

function reviewSuite(
  status: string,
  conclusion: string | null,
  createdAt = '2026-10-23T10:05:00Z',
): Suite {
  return suite({
    app: { slug: 'talos-reviewer' },
    workflowRun: null,
    status,
    conclusion,
    createdAt,
    review: { nodes: [{ status, conclusion }] },
  });
}

const bot = (login: string) => ({ __typename: 'Bot', login });
const user = (login: string) => ({ __typename: 'User', login });

function pr(overrides: Record<string, unknown> = {}): State['pullRequests']['nodes'][number] {
  return {
    number: 88,
    title: 'Squash the claim payload',
    isDraft: false,
    headRefName: 'T-41',
    author: bot('thea-svp'),
    mergeQueueEntry: null,
    autoMergeRequest: { enabledAt: '2026-10-23T09:00:00Z' },
    latestReviews: {
      nodes: [
        {
          author: bot('talos-reviewer'),
          state: 'CHANGES_REQUESTED',
          body: 'talos-review/1 verdict=REQUEST_CHANGES round=1 findings=3\n\nDetails…',
        },
      ],
    },
    commits: {
      nodes: [
        {
          commit: {
            checkSuites: {
              nodes: [
                suite({ conclusion: 'SUCCESS', createdAt: '2026-10-23T09:00:00Z' }),
                suite({ conclusion: 'FAILURE', createdAt: '2026-10-23T09:30:00Z' }),
                reviewSuite('IN_PROGRESS', null),
              ],
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

function state(overrides: Partial<State> = {}): State {
  return {
    talosYml: { text: 'name: Thea\nprefix: T\n' },
    defaultBranchRef: {
      name: 'main',
      target: { oid: MAIN, checkSuites: { nodes: [suite(), reviewSuite('COMPLETED', 'SUCCESS')] } },
    },
    refs: {
      totalCount: 4,
      nodes: [{ name: 'main' }, { name: 'T-41' }, { name: 'T-7' }, { name: 'thea/x' }],
    },
    pullRequests: {
      totalCount: 3,
      nodes: [
        pr(),
        pr({
          number: 90,
          isDraft: true,
          headRefName: 'T-7',
          latestReviews: { nodes: [] },
          autoMergeRequest: null,
        }),
        pr({
          number: 91,
          headRefName: 'dependabot/npm/x',
          author: bot('dependabot'),
          mergeQueueEntry: { position: 1 },
          latestReviews: {
            nodes: [{ author: bot('talos-reviewer'), state: 'APPROVED', body: 'Looks right.' }],
          },
          commits: { nodes: [] },
        }),
      ],
    },
    security: {
      totalCount: 3,
      nodes: [
        {
          number: 12,
          title: 'Bump lodash',
          labels: { nodes: [{ name: 'security' }, { name: 'priority/p2' }] },
        },
        {
          number: 11,
          title: 'PHP 8.4.27 is a security release',
          labels: { nodes: [{ name: 'priority/p0' }] },
        },
        { number: 10, title: 'No priority yet', labels: null },
      ],
    },
    deadCode: { totalCount: 4 },
    otherDebt: { totalCount: 10 },
    openDrift: { totalCount: 1 },
    lastDrift: { nodes: [{ number: 77, createdAt: '2026-10-20T03:17:00Z', state: 'OPEN' }] },
    ...overrides,
  };
}

const pin: Pin = {
  sha: PIN,
  source: 'talos-canary',
  enforcement: 'active',
  path: GATE_PATH,
  channel: 'canary',
};

function claimComment(body: string, author = bot('thea-svp'), association = 'NONE'): ClaimComment {
  return { author, authorAssociation: association, body, createdAt: '2026-10-23T08:00:01Z' };
}

function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    repo: 'SVP-Labs/Thea',
    state: state(),
    properties: { talos: 'canary', agents: 'true' },
    pin,
    version: '1.2.0',
    prefix: 'T',
    comments: new Map([
      [41, [claimComment('🔒 claimed by thea · 2026-10-23T08:00:00Z')]],
      [7, [claimComment('🔒 claimed by mallory · 2026-10-23T08:00:00Z', user('mallory'))]],
    ]),
    who,
    problems: [],
    ...overrides,
  };
}

describe('buildStatus', () => {
  const status = buildStatus(input());

  it('builds a talos.status/1 that validates', () => {
    expect(statusSchema.parse(status)).toEqual(status);
  });

  it('reads channel, agents, pin and main', () => {
    expect(status).toMatchObject({
      schema: 'talos.status/1',
      repo: 'SVP-Labs/Thea',
      channel: 'canary',
      agents: true,
      pin: { sha: PIN, version: '1.2.0', source: 'talos-canary' },
      main: { branch: 'main', sha: MAIN, gate: 'green', review: 'green' },
    });
  });

  it('lists claims from ticket branches, with the trusted claim comment', () => {
    expect(status.claims).toEqual({
      total: 2,
      items: [
        { branch: 'T-7', issue: 7, by: null, since: null, pr: 90 },
        { branch: 'T-41', issue: 41, by: 'thea', since: '2026-10-23T08:00:00Z', pr: 88 },
      ],
    });
  });

  it("gives each PR its stage, the gate's newest run, talos/review and the reviewer's line", () => {
    expect(status.prs.total).toBe(3);
    expect(status.prs.items).toEqual([
      {
        number: 88,
        title: 'Squash the claim payload',
        branch: 'T-41',
        issue: 41,
        author: 'thea-svp[bot]',
        stage: 'ready',
        gate: 'red',
        review: 'pending',
        reviewer: { verdict: 'REQUEST_CHANGES', round: 1, findings: 3 },
        automerge: true,
      },
      expect.objectContaining({
        number: 90,
        stage: 'draft',
        issue: 7,
        reviewer: null,
        automerge: false,
      }),
      expect.objectContaining({
        number: 91,
        stage: 'queued',
        issue: null,
        author: 'dependabot[bot]',
        gate: 'unknown',
        review: 'unknown',
        reviewer: { verdict: 'APPROVE', round: null, findings: null },
      }),
    ]);
  });

  it('puts security issues by priority, then newest', () => {
    expect(status.security).toEqual({
      open: 3,
      top: [
        { number: 11, title: 'PHP 8.4.27 is a security release', priority: 'p0' },
        { number: 12, title: 'Bump lodash', priority: 'p2' },
        { number: 10, title: 'No priority yet', priority: null },
      ],
    });
  });

  it('counts debt and reads the last drift report', () => {
    expect(status.debt).toEqual({ open: 14 });
    expect(status.drift).toEqual({
      open: 1,
      last: { number: 77, date: '2026-10-20T03:17:00Z', state: 'open' },
    });
  });

  it('caps lists and keeps their totals', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `T-${i + 1}` }));
    const prs = Array.from({ length: 25 }, (_, i) =>
      pr({ number: i + 1, headRefName: `T-${i + 1}` }),
    );
    const big = buildStatus(
      input({
        state: state({
          refs: { totalCount: 30, nodes: many },
          pullRequests: { totalCount: 40, nodes: prs },
        }),
        comments: new Map(),
        problems: Array.from({ length: 9 }, (_, i) => `problem ${i} ${'x'.repeat(300)}`),
      }),
    );
    expect(big.claims.total).toBe(30);
    expect(big.claims.items).toHaveLength(MAX_LISTED);
    expect(big.prs).toMatchObject({ total: 40 });
    expect(big.prs.items).toHaveLength(MAX_LISTED);
    expect(big.problems).toHaveLength(5);
    expect(big.problems[0]).toHaveLength(200);
    expect(statusSchema.safeParse(big).success).toBe(true);
  });

  it('copes with an empty repository, no pin and unset properties', () => {
    const bare = buildStatus(
      input({
        state: state({
          talosYml: null,
          defaultBranchRef: null,
          refs: { totalCount: 0, nodes: [] },
          pullRequests: { totalCount: 0, nodes: [] },
          security: { totalCount: 0, nodes: [] },
          lastDrift: { nodes: [] },
        }),
        properties: { talos: undefined, agents: undefined },
        pin: null,
        version: null,
        problems: ['pin: no ruleset that applies to this repository runs the Talos gate'],
      }),
    );
    expect(bare).toMatchObject({
      channel: null,
      agents: false,
      pin: null,
      main: null,
      claims: { total: 0, items: [] },
      drift: { last: null },
    });
    expect(statusSchema.safeParse(bare).success).toBe(true);
    const closed = buildStatus(
      input({
        state: state({ lastDrift: { nodes: [{ number: 5, createdAt: 'd', state: 'CLOSED' }] } }),
      }),
    );
    expect(closed.drift.last?.state).toBe('closed');
  });

  it("takes the channel from the property, else from the pin's ruleset", () => {
    expect(buildStatus(input({ properties: { talos: 'stable', agents: 'false' } })).channel).toBe(
      'stable',
    );
    expect(buildStatus(input({ properties: { talos: undefined, agents: 'false' } })).channel).toBe(
      'canary',
    );
    expect(
      buildStatus(input({ properties: { talos: 'odd', agents: 'false' }, pin: null })).channel,
    ).toBeNull();
  });

  it('clips titles to one line', () => {
    const long = buildStatus(
      input({
        state: state({
          pullRequests: { totalCount: 1, nodes: [pr({ title: `a\nb ${'c'.repeat(200)}` })] },
        }),
      }),
    );
    expect(long.prs.items[0]?.title).toMatch(/^a b c+…$/);
    expect(long.prs.items[0]?.title).toHaveLength(100);
  });
});

describe('gate and review states', () => {
  it('counts only the gate workflow from the Talos repository', () => {
    const fork = suite({
      workflowRun: { file: { path: GATE_PATH, repositoryName: 'evil/Talos-fork' } },
      conclusion: 'FAILURE',
    });
    const local = suite({
      workflowRun: { file: { path: '.github/workflows/ci.yml', repositoryName: 'SVP-Labs/Thea' } },
    });
    expect(gateState([fork, local], 'SVP-Labs/Talos', GATE_PATH)).toBe('unknown');
    const otherPath = suite({
      workflowRun: {
        file: { path: '.github/workflows/self.yml', repositoryName: 'SVP-Labs/Talos' },
      },
    });
    expect(gateState([otherPath], 'SVP-Labs/Talos', GATE_PATH)).toBe('unknown');
    expect(gateState([otherPath], 'SVP-Labs/Talos', null)).toBe('green');
    expect(gateState([suite({ workflowRun: { file: null } })], 'SVP-Labs/Talos', null)).toBe(
      'unknown',
    );
  });

  it('does not take a repository whose name only ends like Talos', () => {
    const lookalike = suite({
      workflowRun: { file: { path: GATE_PATH, repositoryName: 'evil-SVP-Labs/Talos' } },
    });
    expect(gateState([lookalike], 'SVP-Labs/Talos', GATE_PATH)).toBe('unknown');
  });

  it("matches the Talos repository whatever GitHub's URL form or case", () => {
    const url = suite({
      workflowRun: {
        file: { path: GATE_PATH, repositoryName: 'https://github.com/svp-labs/talos' },
      },
    });
    expect(gateState([url], 'SVP-Labs/Talos', GATE_PATH)).toBe('green');
  });

  it('takes the newest gate run on a commit', () => {
    const older = suite({ conclusion: 'FAILURE', createdAt: '2026-10-23T09:00:00Z' });
    const newer = suite({
      status: 'IN_PROGRESS',
      conclusion: null,
      createdAt: '2026-10-23T11:00:00Z',
    });
    expect(gateState([older, newer], 'SVP-Labs/Talos', GATE_PATH)).toBe('pending');
  });

  it("reads talos/review from the reviewer App's newest suite only", () => {
    const impostor = suite({
      app: { slug: 'impostor' },
      review: { nodes: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    });
    expect(reviewState([impostor], who.reviewer)).toBe('unknown');
    const older = reviewSuite('COMPLETED', 'FAILURE', '2026-10-23T09:00:00Z');
    const newer = reviewSuite('COMPLETED', 'SUCCESS', '2026-10-23T10:00:00Z');
    expect(reviewState([newer, older], who.reviewer)).toBe('green');
  });
});

describe('ticket branches', () => {
  it("names an issue by the repository's prefix", () => {
    expect(issueOf('T-41', 'T')).toBe(41);
    expect(issueOf('TL-41', 'T')).toBeNull();
    expect(issueOf('T-041', 'T')).toBeNull();
    expect(issueOf('T-0', 'T')).toBeNull();
    expect(issueOf('thea/x', 'T')).toBeNull();
  });

  it('accepts any valid prefix when talos.yml is unreadable', () => {
    expect(issueOf('LL-12', undefined)).toBe(12);
    expect(issueOf('lower-12', undefined)).toBeNull();
    expect(issueOf('PREFIXES-1', undefined)).toBeNull();
  });

  it('lists ticket branches in issue order', () => {
    expect(claimedBranches(['T-10', 'main', 'T-2', 'X-3'], 'T')).toEqual([
      { branch: 'T-2', issue: 2 },
      { branch: 'T-10', issue: 10 },
    ]);
  });
});

describe('markers', () => {
  it('spells GraphQL logins as REST does', () => {
    expect(loginOf(bot('thea-svp'))).toBe('thea-svp[bot]');
    expect(loginOf(user('SvenPGH'))).toBe('SvenPGH');
    expect(loginOf(null)).toBeNull();
  });

  it('reads a marker line', () => {
    expect(
      markerFields('talos-review/1 verdict=APPROVE round=2 findings=0\nrest', 'talos-review/1'),
    ).toEqual({
      verdict: 'APPROVE',
      round: '2',
      findings: '0',
    });
    expect(markerFields('\n  talos-review/1   verdict=COMMENT  junk', 'talos-review/1')).toEqual({
      verdict: 'COMMENT',
    });
    expect(
      markerFields('Looks right. talos-review/1 verdict=APPROVE', 'talos-review/1'),
    ).toBeUndefined();
    expect(markerFields('talos-review/10 verdict=APPROVE', 'talos-review/1')).toBeUndefined();
    expect(
      markerFields('<!-- talos-review/1 round=2 verdict=APPROVE -->\r\nrest', 'talos-review/1'),
    ).toEqual({ round: '2', verdict: 'APPROVE' });
    expect(markerFields('<!-- talos-review/1 verdict=APPROVE', 'talos-review/1')).toBeUndefined();
  });

  it("takes the reviewer's verdict from its line, else from the review's state", () => {
    expect(
      reviewerVerdict({
        state: 'COMMENTED',
        body: 'talos-review/1 verdict=REQUEST_CHANGES round=2 findings=12',
      }),
    ).toEqual({
      verdict: 'REQUEST_CHANGES',
      round: 2,
      findings: 12,
    });
    expect(
      reviewerVerdict({ state: 'APPROVED', body: 'talos-review/1 verdict=MERGE round=x' }),
    ).toEqual({
      verdict: 'APPROVE',
      round: null,
      findings: null,
    });
    expect(reviewerVerdict({ state: 'COMMENTED', body: '' })).toEqual({
      verdict: 'COMMENT',
      round: null,
      findings: null,
    });
    expect(reviewerVerdict({ state: 'DISMISSED', body: 'gone' })).toBeNull();
  });

  it('reads a priority label', () => {
    expect(priorityOf(['bug', 'priority/p1'])).toBe('p1');
    expect(priorityOf(['p0'])).toBe('p0');
    expect(priorityOf(['priority/p9', 'urgent'])).toBeNull();
  });

  it('clips text to one line', () => {
    expect(clip('a\n\tb\u0000c', 10)).toBe('a b c');
    expect(clip('abcdef', 4)).toBe('abc…');
  });
});

describe('the JSON Schema contract', () => {
  const file: unknown = JSON.parse(
    readFileSync(new URL('../../docs/contracts/status.schema.json', import.meta.url), 'utf8'),
  );

  it('is what the schema in code generates', () => {
    expect(file).toEqual(statusJsonSchema());
  });

  it('accepts what talos status prints and refuses what it never prints', () => {
    const fromFile = z.fromJSONSchema(file as Parameters<typeof z.fromJSONSchema>[0]);
    const statuses: Status[] = [
      buildStatus(input()),
      buildStatus(
        input({ pin: null, version: null, properties: { talos: undefined, agents: undefined } }),
      ),
      { schema: 'talos.status/1', repo: 'o/r', error: 'GET repos/o/r: 404' },
    ];
    for (const status of statuses) expect(fromFile.safeParse(status).success).toBe(true);
    const withCards: RepoStatus = {
      ...buildStatus(input()),
      cards: {
        total: 1,
        items: [{ id: 'c1', pr: 88, title: 'Approve #88', since: '2026-10-23T10:00:00Z' }],
      },
    };
    expect(fromFile.safeParse(withCards).success).toBe(true);
    expect(fromFile.safeParse({ ...buildStatus(input()), extra: 1 }).success).toBe(false);
    expect(fromFile.safeParse({ schema: 'talos.status/2', repo: 'o/r', error: 'x' }).success).toBe(
      false,
    );
  });
});

describe('statusText', () => {
  it('prints one block per repository', () => {
    const text = statusText([
      buildStatus(input()),
      buildStatus(
        input({
          pin: null,
          problems: ['pin: none'],
          state: state({ lastDrift: { nodes: [] }, defaultBranchRef: null }),
        }),
      ),
      { schema: 'talos.status/1', repo: 'o/r', error: 'GET repos/o/r: 404' },
    ]);
    expect(text).toContain(
      'SVP-Labs/Thea · canary · Talos 1.2.0 (aaaaaaaaaaaa, talos-canary) · agents on',
    );
    expect(text).toContain('  main 111111111111: gate green, review green');
    expect(text).toContain('    T-41 by thea since 2026-10-23, PR #88');
    expect(text).toContain('    T-7 by unknown since unknown, PR #90');
    expect(text).toContain(
      '    #88 ready: gate red, review pending, reviewer REQUEST_CHANGES round 1, auto-merge on · Squash the claim payload',
    );
    expect(text).toContain('    #11 p0 · PHP 8.4.27 is a security release');
    expect(text).toContain('    #10 p? · No priority yet');
    expect(text).toContain('  debt: 14 open · drift: 1 open, last #77 2026-10-20 (open)');
    expect(text).toContain('no pin');
    expect(text).toContain('no report yet');
    expect(text).toContain('  problem: pin: none');
    expect(text).toContain('o/r: GET repos/o/r: 404');
  });

  it('says how many more a capped list holds', () => {
    const many = buildStatus(
      input({
        state: state({
          refs: {
            totalCount: 25,
            nodes: Array.from({ length: 25 }, (_, i) => ({ name: `T-${i + 1}` })),
          },
        }),
        comments: new Map(),
        properties: { talos: undefined, agents: 'false' },
      }),
    );
    expect(statusText([many])).toContain('claims: 25, and 5 more');
    expect(statusText([many])).toContain('agents off');
  });
});

type Answers = { rest: Record<string, unknown>; graphql: unknown[] };

function fakeGitHub(answers: Answers, queries: string[] = []): GitHub {
  const rest = (key: string): unknown => {
    if (!(key in answers.rest)) throw new Error(`unexpected ${key}`);
    const value = answers.rest[key];
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    request: <T>(method: string, path: string) => Promise.resolve(rest(`${method} ${path}`) as T),
    paginate: <T>(path: string) => Promise.resolve(rest(`GET ${path}`) as T[]),
    graphql: <T>(query: string) => {
      queries.push(query);
      const next = answers.graphql.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as T);
    },
  };
}

const theaRepo = {
  id: 7,
  full_name: 'SVP-Labs/Thea',
  custom_properties: { talos: 'canary', 'talos-agents': 'true' },
};

function lookupRest(): Record<string, unknown> {
  return {
    'GET repos/SVP-Labs/Thea': theaRepo,
    'GET repos/SVP-Labs/Talos': { id: 900, full_name: 'SVP-Labs/Talos' },
    'GET repos/SVP-Labs/Thea/rulesets?includes_parents=true': [
      { id: 1, name: 'talos-canary', enforcement: 'active' },
    ],
    'GET repos/SVP-Labs/Thea/rulesets/1?includes_parents=true': {
      id: 1,
      name: 'talos-canary',
      enforcement: 'active',
      rules: [
        {
          type: 'workflows',
          parameters: { workflows: [{ path: GATE_PATH, repository_id: 900, sha: PIN }] },
        },
      ],
    },
    [`GET repos/SVP-Labs/Talos/contents/package.json?ref=${PIN}`]: {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(JSON.stringify({ name: '@svp-labs/talos', version: '1.2.0' })).toString(
        'base64',
      ),
      sha: 'b',
    },
  };
}

const claimsAnswer = {
  repository: {
    i7: { comments: { nodes: [] } },
    i41: { comments: { nodes: [claimComment('🔒 claimed by thea · 2026-10-23T08:00:00Z')] } },
  },
};

describe('collecting the state', () => {
  it('reads a repository in two queries and its pin', async () => {
    const queries: string[] = [];
    const gh = fakeGitHub(
      { rest: lookupRest(), graphql: [{ repository: state() }, claimsAnswer] },
      queries,
    );
    const [status] = await statusOf(statusContext(gh, who, 'rulesets'), ['SVP-Labs/Thea']);
    expect(status).toMatchObject({
      repo: 'SVP-Labs/Thea',
      channel: 'canary',
      agents: true,
      pin: { sha: PIN, version: '1.2.0' },
      claims: {
        items: [
          { branch: 'T-7', by: null },
          { branch: 'T-41', by: 'thea' },
        ],
      },
      problems: [],
    });
    expect(queries).toEqual([STATE_QUERY, claimsQuery([7, 41])]);
  });

  it('keeps going without a pin, a talos.yml or every branch, and says so', async () => {
    const rest = { ...lookupRest(), 'GET repos/SVP-Labs/Thea/rulesets?includes_parents=true': [] };
    const partial = state({
      talosYml: { text: 'prefix: [' },
      refs: { totalCount: 150, nodes: [{ name: 'main' }] },
    });
    const gh = fakeGitHub({ rest, graphql: [{ repository: partial }] });
    const [status] = await statusOf(statusContext(gh, who, 'rulesets'), ['SVP-Labs/Thea']);
    expect(status).toMatchObject({
      pin: null,
      problems: [
        'pin: no ruleset that applies to this repository runs the Talos gate',
        'claims: only the 1 newest branches were read',
        'talos.yml on the default branch is invalid',
      ],
    });
  });

  it('reports a missing talos.yml and a pin lookup that failed', async () => {
    const rest = {
      ...lookupRest(),
      'GET repos/SVP-Labs/Talos': new Error('GET repos/SVP-Labs/Talos: 403'),
    };
    const gh = fakeGitHub({
      rest,
      graphql: [{ repository: state({ talosYml: null, refs: { totalCount: 0, nodes: [] } }) }],
    });
    const [status] = await statusOf(statusContext(gh, who, 'rulesets'), ['SVP-Labs/Thea']);
    expect(status).toMatchObject({
      problems: ['pin: GET repos/SVP-Labs/Talos: 403', 'no talos.yml on the default branch'],
    });
  });

  it('turns a repository that cannot be read into an error object', async () => {
    const shapeless = fakeGitHub({ rest: lookupRest(), graphql: [{ repository: { nope: true } }] });
    expect(await statusOf(statusContext(shapeless, who, 'rulesets'), ['SVP-Labs/Thea'])).toEqual([
      {
        schema: 'talos.status/1',
        repo: 'SVP-Labs/Thea',
        error: "GitHub's answer did not have the expected shape",
      },
    ]);
    const missing = fakeGitHub({
      rest: { 'GET repos/o/gone': new Error('GET repos/o/gone: 404') },
      graphql: [],
    });
    expect(await statusOf(statusContext(missing, who, 'rulesets'), ['o/gone'])).toEqual([
      { schema: 'talos.status/1', repo: 'o/gone', error: 'GET repos/o/gone: 404' },
    ]);
    const failing = fakeGitHub({
      rest: lookupRest(),
      graphql: [new Error('graphql: rate limited')],
    });
    const repo = {
      id: 7,
      fullName: 'SVP-Labs/Thea',
      defaultBranch: 'main',
      archived: false,
      private: true,
      properties: {},
    };
    expect(await repoStatus(statusContext(failing, who, 'rulesets'), repo)).toMatchObject({
      error: 'graphql: rate limited',
    });
  });

  it('reads at most four repositories at once and keeps their order', async () => {
    let running = 0;
    let most = 0;
    const gh: GitHub = {
      request: async (_method, path) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 30 - Number(path.slice(-1)) * 4));
        running -= 1;
        throw new Error(`GET ${path}: 404`);
      },
      paginate: () => Promise.reject(new Error('no pagination')),
      graphql: () => Promise.reject(new Error('no graphql')),
    };
    const repos = ['o/r1', 'o/r2', 'o/r3', 'o/r4', 'o/r5', 'o/r6'];
    const statuses = await statusOf(statusContext(gh, who, 'rulesets'), repos);
    expect(statuses.map((s) => s.repo)).toEqual(repos);
    expect(most).toBe(4);
  });

  it('covers every governed, unarchived repository of the organisation, by name', async () => {
    const rest = {
      ...lookupRest(),
      'GET orgs/SVP-Labs/repos?type=all': [
        theaRepo,
        {
          id: 8,
          full_name: 'SVP-Labs/Old',
          archived: true,
          custom_properties: { talos: 'stable' },
        },
        { id: 9, full_name: 'SVP-Labs/Plain', custom_properties: {} },
        { id: 10, full_name: 'SVP-Labs/Beta', custom_properties: { talos: 'evaluate' } },
      ],
      'GET repos/SVP-Labs/Beta/rulesets?includes_parents=true': [],
    };
    const quiet = state({ refs: { totalCount: 0, nodes: [] } });
    const gh = fakeGitHub({ rest, graphql: [{ repository: quiet }, { repository: quiet }] });
    const statuses = await orgStatus(statusContext(gh, who, 'rulesets'));
    expect(statuses.map((s) => s.repo)).toEqual(['SVP-Labs/Beta', 'SVP-Labs/Thea']);
    expect(statuses[0]).toMatchObject({ channel: 'evaluate', pin: null });
  });
});
