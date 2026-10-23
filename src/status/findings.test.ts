import { describe, expect, it } from 'vitest';
import { prFindings } from './findings.js';
import { exec } from '../exec/exec.js';
import { github } from '../github/api.js';

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
      exec,
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
      exec,
      talosRepo: 'svp-labs/talos',
    };
    expect(await prFindings(deps, 'SVP-Labs/Thea', 5)).toMatchObject({
      status: 'unknown',
      head: 'abc',
    });
  });
});
