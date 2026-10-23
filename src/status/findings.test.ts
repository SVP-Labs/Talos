import { describe, expect, it } from 'vitest';
import { prFindings } from './findings.js';
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

function fakeFetch(suites: Suite[], artifacts: { id: number; name: string }[]): typeof fetch {
  return (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/graphql')) {
      return json({ data: { repository: { object: { checkSuites: { nodes: suites } } } } });
    }
    if (url.endsWith('/pulls/5')) return json({ head: { sha: 'abc' } });
    const listed = artifacts.map((a) => ({
      ...a,
      size_in_bytes: 10,
      expired: false,
      archive_download_url: '',
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
});
