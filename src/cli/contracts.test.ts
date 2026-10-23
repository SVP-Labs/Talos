import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Io } from './io.js';
import { ticketWith } from './ticket.js';
import { version } from './version.js';
import { FakeGitHub } from '../ticket/test/fake-github.js';

/**
 * `docs/contracts/` publishes the JSON Thea's hub reads. What the commands really print must
 * satisfy each schema, and each schema must refuse what its contract rules out, so neither can
 * change without the other.
 */
function contract(name: string): z.ZodType {
  const url = new URL(`../../docs/contracts/${name}.schema.json`, import.meta.url);
  const schema: unknown = JSON.parse(readFileSync(url, 'utf8'));
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}

type Printed = { readonly code: number; readonly json: Record<string, unknown> };

function terminal(env: Record<string, string>): Io & { text: () => string } {
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

describe('talos.claim/1', () => {
  const claim = contract('claim');
  let fake: FakeGitHub;

  beforeEach(() => {
    fake = new FakeGitHub();
    fake.files.set('talos.yml', 'name: R\nprefix: R\nagents: { max_claims: 1 }\n');
    fake.addIssue({
      number: 7,
      title: 'Seven',
      body: 'x'.repeat(5000),
      labels: ['bug', 'status/ready', 'ai/eligible', 'priority/p1'],
    });
    fake.addIssue({ number: 8, labels: ['bug'] });
    fake.graphql = () => ({ repository: { pullRequests: { nodes: [] } } });
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
    ];
    const seven = fake.issues.get(7);
    seven?.labels.push('status/ready');
    answers.push(
      await talos('claim', '7', '--agent', 'other'),
      await talos('next', '--agent', 'thea'),
      await talos('release', '7', '--reason', 'the scope is unclear'),
    );
    seven?.labels.splice(0, Infinity, 'bug', 'status/ready');
    answers.push(await talos('next', '--agent', 'thea'));
    expect(answers.map((a) => a.code)).toEqual([1, 0, 3, 4, 0, 4]);
    expect(
      answers.map((a) => a.json.error ?? (a.json.released === true ? 'released' : 'ok')),
    ).toEqual(['refused', 'ok', 'claimed', 'max-claims', 'released', 'none']);
    for (const { json } of answers) expect(claim.safeParse(json).error).toBeUndefined();
    expect(answers[1]?.json).toMatchObject({ bodyTruncated: true, priority: 'p1' });
  });

  it('describes a claim through next, and a release a PR blocks', async () => {
    const taken = await talos('next', '--agent', 'thea');
    expect(taken.json).toMatchObject({ issue: 7, branch: 'R-7', swept: [] });
    fake.pulls.push({ number: 30, draft: true, state: 'open', updated_at: fake.now, head: 'R-7' });
    const blocked = await talos('release', '7', '--reason', 'x');
    expect(blocked.json).toMatchObject({ error: 'refused', reason: 'open-pr', pr: 30 });
    for (const { json } of [taken, blocked]) expect(claim.safeParse(json).error).toBeUndefined();
  });

  it('refuses what the contract rules out', () => {
    const base = { schema: 'talos.claim/1', repo: 'o/r', issue: 7 };
    for (const wrong of [
      { ...base, error: 'claimed' },
      { ...base, error: 'refused', reason: 'tired' },
      { ...base, error: 'claimed', by: 'thea', extra: 1 },
      { ...base, schema: 'talos.claim/2', error: 'claimed', by: null },
      { ...base, released: true, branch: 'r-7', deleted: true },
      { schema: 'talos.claim/1', repo: 'o/r', error: 'none', tried: 0 },
    ]) {
      expect(claim.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });
});

describe('talos.version/1', () => {
  const contractOf = contract('version');
  const PIN = 'a'.repeat(40);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
