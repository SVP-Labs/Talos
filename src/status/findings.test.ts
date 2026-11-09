import { describe, expect, it } from 'vitest';
import { prFindings } from './findings.js';
import { compactVerdict } from '../engine/gate.js';
import { github, GitHubError } from '../github/api.js';
import { makeZip } from '../ticket/test/fake-github.js';

type Suite = {
  createdAt: string;
  workflowRun: { databaseId: number; file: { path: string; repositoryName: string } };
};

function json(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
  );
}

type QueueRun = { id: number; created_at: string; head_branch: string; gate: boolean };

function queueFiles(queue: readonly QueueRun[]) {
  return queue.map((run) => ({
    databaseId: run.id,
    file: {
      path: '.github/workflows/gate.yml',
      repositoryName: run.gate ? 'SVP-Labs/Talos' : 'SVP-Labs/Thea',
    },
  }));
}

function fakeFetch(
  suites: Suite[],
  artifacts: { id: number; name: string; run?: number }[],
  queue: readonly QueueRun[] = [],
): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/graphql')) {
      const query = typeof init?.body === 'string' ? init.body : '';
      if (query.includes('TalosRunFiles')) return json({ data: { nodes: queueFiles(queue) } });
      return json({ data: { repository: { object: { checkSuites: { nodes: suites } } } } });
    }
    if (url.endsWith('/pulls/5')) return json({ head: { sha: 'abc' }, base: { ref: 'main' } });
    if (url.includes('/actions/runs?')) {
      const runs = queue.map(({ gate: _gate, ...run }) => ({ ...run, node_id: `WFR_${run.id}` }));
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    const run = /\/actions\/runs\/(\d+)\/artifacts/.exec(url)?.[1];
    const listed = artifacts
      .filter((a) => run === undefined || a.run === undefined || a.run === Number(run))
      .map(({ run: _run, ...a }) => ({
        ...a,
        size_in_bytes: 10,
        expired: false,
        archive_download_url: `https://api.example/${a.id}`,
      }));
    return json({ total_count: listed.length, artifacts: listed });
  };
}

const gate = (id: number, createdAt: string, repositoryName = 'SVP-Labs/Talos'): Suite => ({
  createdAt,
  workflowRun: { databaseId: id, file: { path: '.github/workflows/gate.yml', repositoryName } },
});

describe('prFindings', () => {
  it('says unknown when no run of Talos gate is on the head', async () => {
    const forged = gate(9, '2026-10-23T10:00:00Z', 'SVP-Labs/Thea');
    const gh = github('t', { fetch: fakeFetch([forged], []) });
    const deps = {
      gh,
      download: () => Promise.resolve(new Uint8Array()),
      talosRepo: 'SVP-Labs/Talos',
    };
    expect(await prFindings(deps, 'SVP-Labs/Thea', 5)).toEqual({
      schema: 'talos.verdict/1',
      status: 'unknown',
      repo: 'SVP-Labs/Thea',
      pr: 5,
      head: 'abc',
    });
  });

  it('says unknown when the newest gate run left no verdict', async () => {
    const suites = [gate(1, '2026-10-23T09:00:00Z'), gate(2, '2026-10-23T10:00:00Z')];
    const gh = github('t', { fetch: fakeFetch(suites, [{ id: 3, name: 'something-else' }]) });
    const deps = {
      gh,
      download: () => Promise.resolve(new Uint8Array()),
      talosRepo: 'svp-labs/talos',
    };
    expect(await prFindings(deps, 'SVP-Labs/Thea', 5)).toMatchObject({
      status: 'unknown',
      head: 'abc',
    });
  });

  const SHA = 'a'.repeat(40);
  const green = {
    schema: 'talos.verdict/1',
    talos: '1.4.0',
    repo: null,
    pr: null,
    mode: 'ready',
    base: SHA,
    head: SHA,
    status: 'green',
    counts: { blocking: 0, existing: 0, faults: 0, byRule: {} },
    blocking: [],
    faults: [],
    flaky: [],
    truncated: false,
  };

  function withArchive(archive: Uint8Array) {
    const suites = [gate(4, '2026-10-23T10:00:00Z')];
    const gh = github('t', { fetch: fakeFetch(suites, [{ id: 3, name: 'talos-verdict' }]) });
    return { gh, download: () => Promise.resolve(archive), talosRepo: 'SVP-Labs/Talos' };
  }

  it('reads the verdict out of the artifact the newest gate run left, in-process', async () => {
    const deps = withArchive(makeZip({ 'verdict.json': JSON.stringify(green) }));
    expect(await prFindings(deps, 'SVP-Labs/Thea', 5)).toEqual({
      ...green,
      repo: 'SVP-Labs/Thea',
      pr: 5,
      head: 'abc',
      run: 4,
    });
  });

  it('fails, rather than answering, when the archive cannot be downloaded', async () => {
    const deps = {
      ...withArchive(new Uint8Array()),
      download: () => Promise.reject(new GitHubError('GET x: 410', 410)),
    };
    await expect(prFindings(deps, 'SVP-Labs/Thea', 5)).rejects.toBeInstanceOf(GitHubError);
  });

  it('says unknown, with why, when the artifact is no archive it can read', async () => {
    for (const archive of [new TextEncoder().encode('not a zip'), new Uint8Array(64)]) {
      const answer = await prFindings(withArchive(archive), 'SVP-Labs/Thea', 5);
      expect(answer).toEqual({
        schema: 'talos.verdict/1',
        status: 'unknown',
        repo: 'SVP-Labs/Thea',
        pr: 5,
        head: 'abc',
        error: 'unreadable artifact: not a zip archive',
      });
    }
    const odd = withArchive(makeZip({ 'verdict.json': '{"status":"red"}' }));
    expect(await prFindings(odd, 'SVP-Labs/Thea', 5)).toMatchObject({
      status: 'unknown',
      error: 'the gate run left a verdict Talos cannot read',
    });
  });

  it('refuses a forged verdict that holds more than Talos prints', async () => {
    const finding = { sha: SHA, rule: 'r', why: 'new', file: null, line: null, message: 'm' };
    const red = { ...green, status: 'red', counts: { ...green.counts, blocking: 1 } };
    const rules = (n: number, length = 2) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`${i}`.padEnd(length, 'r'), 1]));
    const odd = (length: number) => '\u0001'.repeat(length);
    const forged = [
      { ...green, talos: '1'.repeat(51) },
      { ...red, blocking: [{ ...finding, rule: 'r'.repeat(101) }] },
      { ...red, blocking: [{ ...finding, file: 'f'.repeat(301) }] },
      { ...red, counts: { ...red.counts, byRule: rules(1, 101) } },
      { ...red, counts: { ...red.counts, byRule: rules(41) } },
      { ...green, flaky: [{ id: 'i'.repeat(301), file: null }] },
      { ...green, flaky: [{ id: 'i', file: 'f'.repeat(301) }] },
      { ...green, faults: [{ sha: SHA, os: 'linux', check: 'c'.repeat(101), reason: '' }] },
      {
        ...red,
        blocking: Array.from({ length: 20 }, () => ({
          ...finding,
          rule: odd(100),
          file: odd(300),
          message: odd(200),
        })),
        flaky: Array.from({ length: 20 }, () => ({ id: odd(300), file: odd(300) })),
      },
    ];
    for (const verdict of forged) {
      const deps = withArchive(makeZip({ 'verdict.json': JSON.stringify(verdict) }));
      const answer = await prFindings(deps, 'SVP-Labs/Thea', 5);
      expect(answer, JSON.stringify(verdict).slice(0, 120)).toEqual({
        schema: 'talos.verdict/1',
        status: 'unknown',
        repo: 'SVP-Labs/Thea',
        pr: 5,
        head: 'abc',
        error: 'the gate run left a verdict Talos cannot read',
      });
    }
  });

  it('passes the largest verdict the gate itself writes', async () => {
    const odd = (length: number) => '\u0001'.repeat(length);
    const located = (n: number) => ({
      rule: `${n}${odd(200)}`,
      message: odd(500),
      location: { file: odd(500), line: 1 },
      check: 'ts/lint',
      fingerprint: `fp${n}`,
      policy: 'standard' as const,
      isNew: true,
      blocking: true,
      why: 'new' as const,
      sha: SHA,
    });
    const blocking = Array.from({ length: 60 }, (_, n) => located(n));
    const flaky = blocking.map((f) => ({ ...f, rule: 'tests/flaky', key: odd(500) }));
    const written = compactVerdict(
      { findings: [...blocking, ...flaky], blocking, faults: [] },
      { talos: '1.4.0', mode: 'ready', base: SHA, head: SHA },
    );
    const deps = withArchive(makeZip({ 'verdict.json': JSON.stringify(written, null, 2) }));
    const answer = await prFindings(deps, 'SVP-Labs/Thea', 5);
    expect(answer).toEqual({ ...written, repo: 'SVP-Labs/Thea', pr: 5, head: 'abc', run: 4 });
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThan(64 * 1024);
  });

  it("answers with the merge queue's verdict when the queue judged the PR after its head", async () => {
    const red = {
      ...green,
      mode: 'merge-group',
      status: 'red',
      counts: { blocking: 1, existing: 0, faults: 0, byRule: { 'tsc/TS2322': 1 } },
      blocking: [
        { sha: SHA, rule: 'tsc/TS2322', why: 'new', file: 'src/a.ts', line: 3, message: 'No.' },
      ],
    };
    const branch = (pr: number): string => `gh-readonly-queue/main/pr-${pr}-${'b'.repeat(40)}`;
    const queue = [
      { id: 7, created_at: '2026-10-23T11:00:00Z', head_branch: branch(5), gate: true },
      { id: 8, created_at: '2026-10-23T12:00:00Z', head_branch: branch(55), gate: true },
      { id: 9, created_at: '2026-10-23T13:00:00Z', head_branch: branch(5), gate: false },
      { id: 6, created_at: '2026-10-23T09:00:00Z', head_branch: branch(5), gate: true },
    ];
    const artifacts = [
      { id: 3, name: 'talos-verdict', run: 4 },
      { id: 30, name: 'talos-verdict', run: 7 },
    ];
    const zips: Readonly<Record<string, Uint8Array>> = {
      'repos/SVP-Labs/Thea/actions/artifacts/3/zip': makeZip({
        'verdict.json': JSON.stringify(green),
      }),
      'repos/SVP-Labs/Thea/actions/artifacts/30/zip': makeZip({
        'verdict.json': JSON.stringify(red),
      }),
    };
    const deps = {
      gh: github('t', { fetch: fakeFetch([gate(4, '2026-10-23T10:00:00Z')], artifacts, queue) }),
      download: (path: string) => Promise.resolve(zips[path] ?? new Uint8Array()),
      talosRepo: 'SVP-Labs/Talos',
    };
    expect(await prFindings(deps, 'SVP-Labs/Thea', 5)).toEqual({
      ...red,
      repo: 'SVP-Labs/Thea',
      pr: 5,
      head: 'abc',
      run: 7,
    });
    const before = queue.map((run) => ({ ...run, created_at: '2026-10-23T09:30:00Z' }));
    const headFirst = {
      ...deps,
      gh: github('t', { fetch: fakeFetch([gate(4, '2026-10-23T10:00:00Z')], artifacts, before) }),
    };
    expect(await prFindings(headFirst, 'SVP-Labs/Thea', 5)).toMatchObject({
      run: 4,
      status: 'green',
    });
  });
});
