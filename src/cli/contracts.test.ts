import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Io } from './io.js';
import { main } from './main.js';
import { ticketWith } from './ticket.js';
import { version } from './version.js';
import { compactVerdict } from '../engine/gate.js';
import { FakeGitHub, makeZip } from '../ticket/test/fake-github.js';

/**
 * `docs/contracts/` publishes the JSON Thea's hub reads. What the commands really print must
 * satisfy each schema, and each schema must refuse what its contract rules out, so neither can
 * change without the other. Thea's hub runs each command with `--json` appended and the
 * environment below, so the commands are run here the same way, through `talos`'s own entry.
 */
function contract(name: string): z.ZodType {
  const url = new URL(`../../docs/contracts/${name}.schema.json`, import.meta.url);
  const schema: unknown = JSON.parse(readFileSync(url, 'utf8'));
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}

type Printed = { readonly code: number; readonly json: Record<string, unknown> };

const PIN = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);

/** What Thea's hub hands every Talos it runs: a path, a home, the token, the release. */
const HUB_ENV: Readonly<Record<string, string>> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/node',
  GH_TOKEN: 'thea-svp[bot]',
  TALOS_VERSION: '1.4.0',
  TALOS_SHA: PIN,
  NO_COLOR: '1',
};

function terminal(env: Readonly<Record<string, string>>): Io & { text: () => string } {
  let out = '';
  return {
    cwd: '/nowhere',
    env,
    out: (text) => {
      out += text;
    },
    err: () => undefined,
    text: () => out,
  };
}

function parsed(text: string): Record<string, unknown> {
  const json: unknown = JSON.parse(text);
  return z.record(z.string(), z.unknown()).parse(json);
}

/** `talos <argv> --json` as Thea's hub runs it, against the fake GitHub; one JSON value. */
async function asTheHub(fake: FakeGitHub, ...argv: string[]): Promise<Printed & { all: unknown }> {
  vi.stubGlobal('fetch', fake.fetch);
  const io = terminal(HUB_ENV);
  const code = await main([...argv, '--json'], io);
  const all: unknown = JSON.parse(io.text());
  const first: unknown = Array.isArray(all) ? all[0] : all;
  return { code, json: z.record(z.string(), z.unknown()).parse(first), all };
}

function governed(): FakeGitHub {
  const fake = new FakeGitHub();
  fake.files.set('talos.yml', 'name: R\nprefix: R\nagents: { max_claims: 1 }\n');
  fake.addIssue({
    number: 7,
    title: 'Seven',
    body: 'x'.repeat(5000),
    labels: ['bug', 'status/ready', 'ai/eligible', 'priority/p1'],
  });
  fake.addIssue({ number: 8, labels: ['bug'] });
  fake.graphql = () => ({ repository: { pullRequests: { nodes: [] } } });
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('talos.claim/1', () => {
  const claim = contract('claim');
  let fake: FakeGitHub;

  beforeEach(() => {
    fake = governed();
  });

  async function talos(...argv: string[]): Promise<Printed> {
    const io = terminal({ GITHUB_TOKEN: 'thea-svp[bot]', GITHUB_REPOSITORY: 'o/r' });
    const code = await ticketWith({ fetch: fake.fetch })(argv, io);
    return { code, json: parsed(io.text()) };
  }

  it('describes every answer claim, next and release give', async () => {
    const answers = [
      await talos('claim', '8', '--agent', 'thea'),
      await talos('claim', '7', '--agent', 'thea'),
      await talos('claim', '7', '--agent', 'other'),
      await talos('next', '--agent', 'thea'),
      await talos('release', '7', '--reason', 'the scope is unclear'),
      await talos('release', '99', '--reason', 'gone'),
    ];
    fake.issues.get(7)?.labels.splice(0, Infinity, 'bug', 'status/ready');
    answers.push(await talos('next', '--agent', 'thea'));
    expect(answers.map((a) => a.code)).toEqual([1, 0, 3, 4, 0, 1, 4]);
    expect(
      answers.map((a) => a.json.error ?? (a.json.released === true ? 'released' : 'ok')),
    ).toEqual(['refused', 'ok', 'claimed', 'max-claims', 'released', 'refused', 'none']);
    for (const { json } of answers) expect(claim.safeParse(json).error).toBeUndefined();
    expect(answers[1]?.json).toMatchObject({ bodyTruncated: true, priority: 'p1' });
    expect(answers[1]?.json.issue).toBe(answers[1]?.json.number);
    expect(answers[2]?.json).toMatchObject({ error: 'claimed', by: 'thea' });
    expect(answers[5]?.json).toMatchObject({ error: 'refused', reason: 'not-found' });
  });

  it('describes a claim through next, and a release a PR blocks', async () => {
    const taken = await talos('next', '--agent', 'thea');
    expect(taken.json).toMatchObject({ issue: 7, number: 7, branch: 'R-7', swept: [] });
    fake.pulls.push({ number: 30, draft: true, state: 'open', updated_at: fake.now, head: 'R-7' });
    const blocked = await talos('release', '7', '--reason', 'x');
    expect(blocked.json).toMatchObject({ error: 'refused', reason: 'open-pr', pr: 30 });
    for (const { json } of [taken, blocked]) expect(claim.safeParse(json).error).toBeUndefined();
  });

  it("answers Thea's hub, which appends --json to every command", async () => {
    const hub = (...argv: string[]) => asTheHub(fake, 'ticket', ...argv, '--repo', 'o/r');
    const answers = [await hub('claim', '7', '--agent', 'thea')];
    answers.push(
      await hub('claim', '7', '--agent', 'thea'),
      await hub('claim', '8', '--agent', 'thea'),
      await hub('next', '--agent', 'thea'),
      await hub('release', '7', '--reason', "Thea's task couldn't start: the machine is away"),
      await hub('next', '--agent', 'thea'),
    );
    expect(answers.map((a) => [a.code, a.json.error ?? a.json.released ?? a.json.branch])).toEqual([
      [0, 'R-7'],
      [3, 'claimed'],
      [1, 'refused'],
      [4, 'max-claims'],
      [0, true],
      [0, 'R-7'],
    ]);
    expect(answers[1]?.json).toMatchObject({ by: 'thea', repo: 'o/r', issue: 7 });
    for (const { json } of answers) {
      expect(json.schema).toBe('talos.claim/1');
      expect(claim.safeParse(json).error).toBeUndefined();
    }
  });

  it('refuses what the contract rules out', () => {
    const base = { schema: 'talos.claim/1', repo: 'o/r', issue: 7 };
    for (const wrong of [
      { ...base, error: 'claimed' },
      { ...base, error: 'refused', reason: 'tired' },
      { ...base, error: 'refused', reason: 'open-pr' },
      { ...base, error: 'refused', reason: 'not-ready', pr: 30 },
      { ...base, error: 'claimed', by: 'thea', extra: 1 },
      { ...base, schema: 'talos.claim/2', error: 'claimed', by: null },
      { ...base, released: true, branch: 'r-7', deleted: true },
      { schema: 'talos.claim/1', repo: 'o/r', error: 'none', tried: 0 },
    ]) {
      expect(claim.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });
});

const MAIN = '1'.repeat(40);

/** `talos status`'s two queries, answered for `o/r`: its state, then its claims' comments. */
function stateOf(query: string): unknown {
  if (query.includes('TalosClaims')) {
    const by = { __typename: 'Bot', login: 'thea-svp' };
    const body = '🔒 claimed by thea · 2026-10-23T08:00:00Z';
    const comment = {
      author: by,
      authorAssociation: 'NONE',
      body,
      createdAt: '2026-10-23T08:00:00Z',
    };
    return { repository: { i7: { comments: { nodes: [comment] } } } };
  }
  const none = { totalCount: 0, nodes: [] };
  const pull = {
    number: 9,
    title: 'Serve talos_status',
    isDraft: true,
    headRefName: 'R-7',
    author: { __typename: 'Bot', login: 'thea-svp' },
    mergeQueueEntry: null,
    autoMergeRequest: null,
    latestReviews: { nodes: [] },
    commits: { nodes: [] },
  };
  return {
    repository: {
      talosYml: { text: 'name: R\nprefix: R\n' },
      defaultBranchRef: { name: 'main', target: { oid: MAIN, checkSuites: { nodes: [] } } },
      refs: { totalCount: 2, nodes: [{ name: 'main' }, { name: 'R-7' }] },
      pullRequests: { totalCount: 1, nodes: [pull] },
      security: none,
      deadCode: { totalCount: 2 },
      otherDebt: { totalCount: 1 },
      openDrift: { totalCount: 0 },
      lastDrift: { nodes: [] },
    },
  };
}

describe('talos.status/1', () => {
  const statusContract = contract('status');

  it("answers Thea's hub with one element per repository", async () => {
    const fake = governed();
    fake.properties['talos-agents'] = 'true';
    fake.graphql = stateOf;
    const read = await asTheHub(fake, 'status', '--repo', 'o/r');
    expect(read.code).toBe(0);
    expect(read.all).toHaveLength(1);
    expect(read.json).toMatchObject({
      schema: 'talos.status/1',
      repo: 'o/r',
      agents: true,
      claims: { total: 1, items: [{ branch: 'R-7', issue: 7, by: 'thea', pr: 9 }] },
      prs: {
        total: 1,
        items: [{ number: 9, title: 'Serve talos_status', author: 'thea-svp[bot]' }],
      },
      debt: { open: 3 },
    });
    expect(statusContract.safeParse(read.json).error).toBeUndefined();
  });

  it('exits 1 for a repository it cannot read, which its element names', async () => {
    const read = await asTheHub(governed(), 'status', '--repo', 'o/gone');
    expect(read.code).toBe(1);
    expect(read.json).toMatchObject({ schema: 'talos.status/1', repo: 'o/gone' });
    expect(read.json.error).toEqual(expect.any(String));
    expect(statusContract.safeParse(read.json).error).toBeUndefined();
  });
});

describe('talos.verdict/1 from talos findings', () => {
  const verdictContract = contract('verdict');
  const GATE = { path: '.github/workflows/gate.yml', repositoryName: 'SVP-Labs/Talos' };
  let fake: FakeGitHub;

  beforeEach(() => {
    fake = governed();
    fake.refs.set('R-7', HEAD);
    fake.pulls.push({ number: 5, draft: false, state: 'open', updated_at: fake.now, head: 'R-7' });
    fake.graphql = (_query, variables) => {
      const nodes =
        variables.sha === HEAD
          ? [{ createdAt: '2026-10-23T10:00:00Z', workflowRun: { databaseId: 77, file: GATE } }]
          : [];
      return { repository: { object: { checkSuites: { nodes } } } };
    };
  });

  function uploaded(verdict: string): void {
    const zip = makeZip({ 'verdict.json': verdict });
    fake.artifacts.push({
      id: 3,
      run: 77,
      name: 'talos-verdict',
      created_at: '2026-10-23T10:05:00Z',
      expired: false,
      size_in_bytes: zip.length,
      zip,
    });
  }

  it("answers Thea's hub with the gate's verdict, exiting 1 when it is red", async () => {
    const located = {
      rule: 'eslint/complexity',
      message: 'Function has a complexity of 14.',
      location: { file: 'src/a.ts', line: 3 },
      check: 'ts/lint',
      fingerprint: 'fp',
      policy: 'standard' as const,
      isNew: true,
      blocking: true,
      why: 'new' as const,
      sha: HEAD,
    };
    const verdict = compactVerdict(
      { findings: [located], blocking: [located], faults: [] },
      { talos: '1.4.0', repo: 'o/r', pr: 5, mode: 'ready', base: MAIN, head: HEAD },
    );
    uploaded(JSON.stringify(verdict));
    const read = await asTheHub(fake, 'findings', '--repo', 'o/r', '--pr', '5');
    expect(read.code).toBe(1);
    expect(read.json).toEqual({ ...verdict, run: 77 });
    expect(verdictContract.safeParse(read.json).error).toBeUndefined();
  });

  it('says unknown, exiting 0, when no gate run left a verdict it can read', async () => {
    const none = await asTheHub(fake, 'findings', '--repo', 'o/r', '--pr', '5');
    uploaded('{"schema":"talos.verdict/1","status":"red","blocking":[]}');
    const unreadable = await asTheHub(fake, 'findings', '--repo', 'o/r', '--pr', '5');
    expect(none).toMatchObject({
      code: 0,
      json: { schema: 'talos.verdict/1', status: 'unknown', repo: 'o/r', pr: 5, head: HEAD },
    });
    expect(unreadable).toMatchObject({ code: 0, json: { status: 'unknown', head: HEAD } });
    expect(unreadable.json.error).toEqual(expect.any(String));
    for (const { json } of [none, unreadable]) {
      expect(verdictContract.safeParse(json).error).toBeUndefined();
    }
  });

  it('refuses an unknown answer that names no head, or carries more', () => {
    const unknown = { schema: 'talos.verdict/1', status: 'unknown', repo: 'o/r', pr: 5 };
    expect(verdictContract.safeParse(unknown).success).toBe(false);
    expect(verdictContract.safeParse({ ...unknown, head: HEAD, run: 77 }).success).toBe(false);
    expect(verdictContract.safeParse({ ...unknown, head: HEAD }).success).toBe(true);
  });
});

describe('talos.version/1', () => {
  const contractOf = contract('version');

  async function enforced(env: Record<string, string>, ...argv: string[]): Promise<Printed> {
    const io = terminal(env);
    const code = await version(['--enforced', '--json', ...argv], io);
    return { code, json: parsed(io.text()) };
  }

  it("describes the release Thea's hub hands over", async () => {
    const given = await enforced({ TALOS_VERSION: '1.4.0', TALOS_SHA: PIN }, '--repo', 'o/r');
    expect(given.json).toEqual({
      schema: 'talos.version/1',
      repo: 'o/r',
      version: '1.4.0',
      sha: PIN,
      from: 'environment',
    });
    expect(contractOf.safeParse(given.json).error).toBeUndefined();
  });

  it("describes the release a repository's rulesets pin", async () => {
    const answers: Readonly<Record<string, unknown>> = {
      'repos/SVP-Labs/Talos': { id: 900, full_name: 'SVP-Labs/Talos' },
      'repos/o/r/rulesets?includes_parents=true&per_page=100': [
        { id: 3, name: 'talos-canary', enforcement: 'active' },
      ],
      'repos/o/r/rulesets/3?includes_parents=true': {
        id: 3,
        name: 'talos-canary',
        enforcement: 'active',
        rules: [
          {
            type: 'workflows',
            parameters: {
              workflows: [
                { repository_id: 900, path: '.github/workflows/gate.yml', sha: PIN, ref: 'v1.4.0' },
              ],
            },
          },
        ],
      },
      [`repos/SVP-Labs/Talos/contents/package.json?ref=${PIN}`]: {
        type: 'file',
        encoding: 'base64',
        sha: 'b'.repeat(40),
        content: Buffer.from('{"name":"@svp-labs/talos","version":"1.4.0"}').toString('base64'),
      },
    };
    vi.stubGlobal('fetch', (url: string) => {
      const body = answers[url.replace('https://api.github.com/', '')];
      return Promise.resolve(
        body === undefined
          ? new Response('', { status: 404 })
          : Response.json(body, { headers: { 'content-type': 'application/json' } }),
      );
    });
    const looked = await enforced({ GITHUB_TOKEN: 't' }, '--repo', 'o/r');
    expect(looked).toMatchObject({
      code: 0,
      json: { from: 'rulesets', pin: { source: 'talos-canary', channel: 'canary' } },
    });
    expect(contractOf.safeParse(looked.json).error).toBeUndefined();
    const { pin: _pin, ...withoutPin } = looked.json;
    expect(contractOf.safeParse({ ...withoutPin, sha: 'v1.4.0' }).success).toBe(false);
    expect(contractOf.safeParse({ ...withoutPin, from: 'npm' }).success).toBe(false);
  });
});
