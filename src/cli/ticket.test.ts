import { beforeEach, describe, expect, it } from 'vitest';
import { type Io, UsageError } from './io.js';
import { ticketRequest, ticketWith } from './ticket.js';
import { FakeGitHub } from '../ticket/test/fake-github.js';

type Run = { code: number; json: Record<string, unknown> };

describe('talos ticket', () => {
  let fake: FakeGitHub;

  beforeEach(() => {
    fake = new FakeGitHub();
    fake.files.set('talos.yml', 'name: R\nprefix: R\nagents: { max_claims: 1 }\n');
    fake.addIssue({ number: 7, title: 'Seven', labels: ['bug', 'status/ready', 'ai/eligible'] });
    fake.addIssue({ number: 8, labels: ['bug'] });
    fake.graphql = () => ({ repository: { pullRequests: { nodes: [] } } });
  });

  async function talos(...argv: string[]): Promise<Run> {
    let out = '';
    const io: Io = {
      cwd: '/nowhere',
      env: { GITHUB_TOKEN: 'thea-svp[bot]', GITHUB_REPOSITORY: 'o/r' },
      out: (text) => {
        out += text;
      },
      err: () => undefined,
    };
    const code = await ticketWith({ fetch: fake.fetch })(argv, io);
    const json: unknown = JSON.parse(out);
    if (typeof json !== 'object' || json === null) throw new Error('not an object');
    return { code, json: Object.fromEntries(Object.entries(json)) };
  }

  it('claims, prints the payload, and exits 0', async () => {
    const { code, json } = await talos('claim', '7', '--agent', 'thea');
    expect(code).toBe(0);
    expect(json).toMatchObject({
      schema: 'talos.claim/1',
      repo: 'o/r',
      issue: 7,

      branch: 'R-7',
      agent: 'thea',
      title: 'Seven',
      priority: 'p3',
    });
    expect(fake.refs.has('R-7')).toBe(true);
  });

  it('exits 3 when someone holds the claim, naming them', async () => {
    await talos('claim', '7', '--agent', 'thea');
    fake.issues.get(7)?.labels.push('status/ready');
    const { code, json } = await talos('claim', '7', '--agent', 'other');
    expect(code).toBe(3);
    expect(json).toMatchObject({ schema: 'talos.claim/1', error: 'claimed', by: 'thea' });
  });

  it('exits 1 when the issue cannot be claimed', async () => {
    const { code, json } = await talos('claim', '8', '--agent', 'thea');
    expect(code).toBe(1);
    expect(json).toMatchObject({ error: 'refused', reason: 'not-ready' });
  });

  it('takes the next ticket, then exits 4 at max_claims', async () => {
    expect(await talos('next', '--agent', 'thea')).toMatchObject({
      code: 0,
      json: { schema: 'talos.claim/1', issue: 7, branch: 'R-7', swept: [] },
    });
    expect(await talos('next', '--agent', 'thea')).toMatchObject({
      code: 4,
      json: { error: 'max-claims', claims: 1, max: 1 },
    });
  });

  it('exits 4 when the queue is empty', async () => {
    fake.issues.get(7)?.labels.splice(2, 1);
    expect(await talos('next', '--agent', 'thea')).toMatchObject({
      code: 4,
      json: { error: 'none' },
    });
  });

  it('releases, and reports status', async () => {
    await talos('claim', '7', '--agent', 'thea');
    expect(await talos('status', '7')).toMatchObject({
      code: 0,
      json: { claimed: true, agent: 'thea' },
    });
    expect(await talos('release', '7', '--reason', 'the scope is unclear')).toMatchObject({
      code: 0,
      json: { released: true, deleted: true },
    });
    expect(await talos('status', '7')).toMatchObject({ code: 0, json: { claimed: false } });
  });

  it('exits 1 when a PR is open from the branch it would release', async () => {
    await talos('claim', '7', '--agent', 'thea');
    fake.pulls.push({ number: 30, draft: true, state: 'open', updated_at: fake.now, head: 'R-7' });
    expect(await talos('release', '7', '--reason', 'x')).toMatchObject({
      code: 1,
      json: { reason: 'open-pr', pr: 30 },
    });
  });

  it('refuses bad usage before calling GitHub', async () => {
    await expect(talos()).rejects.toThrow(UsageError);
    await expect(talos('steal', '7')).rejects.toThrow(UsageError);
    await expect(talos('claim', '7')).rejects.toThrow(/--agent is required/);
    await expect(talos('claim', 'seven', '--agent', 'thea')).rejects.toThrow(/issue number/);
    await expect(talos('claim', '7', '--agent', 'talos-approve')).rejects.toThrow(/talos-approve/);
    await expect(talos('release', '7', '--reason', 'talos-approve c1 abc')).rejects.toThrow(
      /talos-approve/,
    );
    await expect(talos('claim', '7', '--agent', 'thea', '--repo', 'not a repo')).rejects.toThrow(
      /owner\/name/,
    );
    expect(fake.writes()).toEqual([]);
  });

  it('fails when the repository has no talos.yml', async () => {
    fake.files.clear();
    await expect(talos('status', '7')).rejects.toThrow(/not governed/);
  });
});

describe('ticketRequest', () => {
  const none = { issue: undefined, agent: undefined, reason: undefined };

  it('reads each subcommand', () => {
    expect(ticketRequest('claim', { ...none, issue: '7', agent: 'thea' })).toEqual({
      sub: 'claim',
      issue: 7,
      agent: 'thea',
    });
    expect(ticketRequest('next', { ...none, agent: 'thea' })).toEqual({
      sub: 'next',
      agent: 'thea',
    });
    expect(ticketRequest('release', { ...none, issue: '7', reason: 'r' })).toEqual({
      sub: 'release',
      issue: 7,
      reason: 'r',
    });
    expect(ticketRequest('status', { ...none, issue: '7' })).toEqual({ sub: 'status', issue: 7 });
  });

  it('refuses what it cannot run', () => {
    expect(() => ticketRequest(undefined, none)).toThrow(/usage: talos ticket/);
    expect(() => ticketRequest('status', { ...none, issue: '0' })).toThrow(/issue number/);
    expect(() => ticketRequest('release', { ...none, issue: '7' })).toThrow(/--reason is required/);
    expect(() => ticketRequest('next', none)).toThrow(/--agent is required/);
  });
});

describe('talos ticket without a repository', () => {
  it('asks for --repo outside a clone', async () => {
    const io: Io = {
      cwd: '/',
      env: { GITHUB_TOKEN: 't' },
      out: () => undefined,
      err: () => undefined,
    };
    await expect(ticketWith({})(['status', '1'], io)).rejects.toThrow(/pass --repo owner\/name/);
  });
});
