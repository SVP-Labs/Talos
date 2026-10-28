import { describe, expect, it } from 'vitest';
import { listRunArtifacts, listRunJobs, listWorkflowRuns } from './actions.js';
import { github, type GitHub, GitHubError } from './api.js';
import { appId } from './apps.js';
import { downloader } from './artifacts.js';
import { createCheckRun, listCheckRuns, stateOf, updateCheckRun } from './checks.js';
import { readFileAt } from './contents.js';
import { pullsForCommit } from './pulls.js';
import { currentRepository, isRepoName } from './remote.js';
import {
  getRepository,
  listInstallationRepositories,
  listOrgRepositories,
  listPropertyValues,
  propertyOf,
} from './repos.js';
import { getRuleset, listRulesets, requiredWorkflows } from './rulesets.js';
import type { Exec } from '../exec/exec.js';

type Call = { method: string; path: string; body?: unknown };

/** A GitHub whose answers are keyed by `METHOD path`; anything else fails the test. */
function fakeGitHub(answers: Record<string, unknown>, calls: Call[] = []): GitHub {
  const answer = (method: string, path: string): unknown => {
    const key = `${method} ${path}`;
    if (!(key in answers)) throw new Error(`unexpected ${key}`);
    return answers[key];
  };
  return {
    request: <T>(method: string, path: string, options?: { body?: unknown }) => {
      calls.push({ method, path, body: options?.body });
      return Promise.resolve(answer(method, path) as T);
    },
    paginate: <T>(path: string) => {
      calls.push({ method: 'PAGINATE', path });
      return Promise.resolve(answer('GET', path) as T[]);
    },
    graphql: () => Promise.reject(new Error('no graphql here')),
  };
}

const repoJson = {
  id: 7,
  full_name: 'SVP-Labs/Thea',
  default_branch: 'main',
  archived: false,
  private: true,
  custom_properties: { talos: 'canary', 'talos-agents': 'true', teams: ['a', 'b'] },
};

describe('repositories', () => {
  it('reads a repository with its custom properties', async () => {
    const repo = await getRepository(
      fakeGitHub({ 'GET repos/SVP-Labs/Thea': repoJson }),
      'SVP-Labs/Thea',
    );
    expect(repo).toEqual({
      id: 7,
      fullName: 'SVP-Labs/Thea',
      defaultBranch: 'main',
      archived: false,
      private: true,
      properties: { talos: 'canary', 'talos-agents': 'true', teams: ['a', 'b'] },
    });
    expect(propertyOf(repo, 'talos')).toBe('canary');
    expect(propertyOf(repo, 'teams')).toBeUndefined();
    expect(propertyOf(repo, 'missing')).toBeUndefined();
  });

  it('defaults what GitHub leaves out', async () => {
    const repo = await getRepository(
      fakeGitHub({ 'GET repos/a/b': { id: 1, full_name: 'a/b' } }),
      'a/b',
    );
    expect(repo).toMatchObject({
      defaultBranch: 'main',
      archived: false,
      private: false,
      properties: {},
    });
    expect(propertyOf({ ...repo, properties: { talos: '' } }, 'talos')).toBeUndefined();
  });

  it("lists an organisation's and an installation's repositories", async () => {
    const calls: Call[] = [];
    const gh = fakeGitHub(
      {
        'GET orgs/SVP-Labs/repos?type=all': [repoJson],
        'GET installation/repositories': [repoJson],
      },
      calls,
    );
    expect((await listOrgRepositories(gh, 'SVP-Labs')).map((r) => r.fullName)).toEqual([
      'SVP-Labs/Thea',
    ]);
    expect(await listInstallationRepositories(gh)).toHaveLength(1);
    expect(calls.map((c) => c.method)).toEqual(['PAGINATE', 'PAGINATE']);
  });

  it("lists the organisation's custom property values, narrowed by a repository search", async () => {
    const row = {
      repository_id: 7,
      repository_name: 'Thea',
      repository_full_name: 'SVP-Labs/Thea',
      properties: [
        { property_name: 'talos', value: 'canary' },
        { property_name: 'teams', value: ['a', 'b'] },
      ],
    };
    const calls: Call[] = [];
    const gh = fakeGitHub(
      {
        'GET orgs/SVP-Labs/properties/values': [row],
        [`GET orgs/SVP-Labs/properties/values?repository_query=${encodeURIComponent('is:private')}`]:
          [],
      },
      calls,
    );
    expect(await listPropertyValues(gh, 'SVP-Labs')).toEqual([
      { id: 7, fullName: 'SVP-Labs/Thea', properties: { talos: 'canary', teams: ['a', 'b'] } },
    ]);
    expect(await listPropertyValues(gh, 'SVP-Labs', 'is:private')).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(['PAGINATE', 'PAGINATE']);
    await expect(
      listPropertyValues(fakeGitHub({ 'GET orgs/o/properties/values': [{ id: 1 }] }), 'o'),
    ).rejects.toThrow();
  });

  it('refuses an answer of the wrong shape', async () => {
    await expect(
      getRepository(fakeGitHub({ 'GET repos/a/b': { id: 'x' } }), 'a/b'),
    ).rejects.toThrow();
  });
});

describe('readFileAt', () => {
  const content = Buffer.from('{ "version": "1.2.0" }').toString('base64');

  it('decodes a file at a ref', async () => {
    const gh = fakeGitHub({
      'GET repos/o/r/contents/package.json?ref=abc': {
        type: 'file',
        encoding: 'base64',
        content,
        sha: 's',
      },
    });
    expect(await readFileAt(gh, 'o/r', 'package.json', 'abc')).toBe('{ "version": "1.2.0" }');
  });

  it('encodes each path segment and the ref', async () => {
    const gh = fakeGitHub({
      [`GET repos/o/r/contents/docs/a%20b.md?ref=${encodeURIComponent('refs/heads/x')}`]: {
        type: 'file',
        encoding: 'base64',
        content: `${content.slice(0, 4)}\n${content.slice(4)}`,
        sha: 's',
      },
    });
    expect(await readFileAt(gh, 'o/r', '/docs/a b.md', 'refs/heads/x')).toContain('1.2.0');
  });

  it('is undefined for a missing path', async () => {
    const gh = fakeGitHub({ 'GET repos/o/r/contents/x?ref=main': undefined });
    expect(await readFileAt(gh, 'o/r', 'x', 'main')).toBeUndefined();
  });

  it('reads a large file through the blob API', async () => {
    const gh = fakeGitHub({
      'GET repos/o/r/contents/big?ref=main': {
        type: 'file',
        encoding: 'none',
        content: '',
        sha: 'b1',
      },
      'GET repos/o/r/git/blobs/b1': { encoding: 'base64', content },
    });
    expect(await readFileAt(gh, 'o/r', 'big', 'main')).toContain('version');
  });

  it('refuses a directory', async () => {
    const gh = fakeGitHub({ 'GET repos/o/r/contents/src?ref=main': [{ type: 'file' }] });
    await expect(readFileAt(gh, 'o/r', 'src', 'main')).rejects.toBeInstanceOf(GitHubError);
  });
});

describe('rulesets', () => {
  it('lists with the organisation included and reads one through the repository', async () => {
    const calls: Call[] = [];
    const gh = fakeGitHub(
      {
        'GET repos/o/r/rulesets?includes_parents=true': [
          { id: 1, name: 'talos-canary', enforcement: 'active', source_type: 'Organization' },
        ],
        'GET repos/o/r/rulesets/1?includes_parents=true': {
          id: 1,
          name: 'talos-canary',
          enforcement: 'active',
          rules: [
            { type: 'pull_request', parameters: {} },
            {
              type: 'workflows',
              parameters: {
                workflows: [
                  { path: '.github/workflows/gate.yml', repository_id: 9, sha: 'a'.repeat(40) },
                ],
              },
            },
            { type: 'workflows', parameters: { unexpected: true } },
          ],
        },
      },
      calls,
    );
    expect(await listRulesets(gh, 'o/r')).toEqual([
      { id: 1, name: 'talos-canary', enforcement: 'active', source_type: 'Organization' },
    ]);
    const ruleset = await getRuleset(gh, 'o/r', 1);
    expect(requiredWorkflows(ruleset)).toEqual([
      { path: '.github/workflows/gate.yml', repository_id: 9, sha: 'a'.repeat(40) },
    ]);
    expect(requiredWorkflows({ ...ruleset, rules: [] })).toEqual([]);
  });

  it('paginates through the real client with includes_parents kept', async () => {
    const urls: string[] = [];
    const fetchFake: typeof fetch = (input) => {
      const url = urlOf(input);
      urls.push(url);
      const next = url.includes('page=2')
        ? {}
        : {
            link: '<https://api.github.com/repos/o/r/rulesets?includes_parents=true&per_page=100&page=2>; rel="next"',
          };
      const body = url.includes('page=2')
        ? [{ id: 2, name: 'b', enforcement: 'evaluate' }]
        : [{ id: 1, name: 'a', enforcement: 'disabled' }];
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json', ...next },
        }),
      );
    };
    const rulesets = await listRulesets(github('t', { fetch: fetchFake }), 'o/r');
    expect(rulesets.map((r) => r.id)).toEqual([1, 2]);
    expect(urls[0]).toBe(
      'https://api.github.com/repos/o/r/rulesets?includes_parents=true&per_page=100',
    );
  });
});

describe('a refused request', () => {
  const refusing =
    (body: string, status = 422): typeof fetch =>
    () =>
      Promise.resolve(new Response(body, { status }));
  const refusal = async (body: string): Promise<GitHubError> => {
    const error: unknown = await github('t', { fetch: refusing(body) })
      .request('POST', 'repos/o/r/rulesets', { body: {} })
      .catch((e: unknown) => e);
    if (!(error instanceof GitHubError)) throw new Error('expected a GitHubError');
    return error;
  };

  it("keeps GitHub's reason apart from the message, with its errors", async () => {
    const error = await refusal(
      JSON.stringify({ message: 'Validation Failed', errors: ['Actor X must be part of it'] }),
    );
    expect(error.message).toBe('POST repos/o/r/rulesets: 422');
    expect(error.reason).toBe('Validation Failed: Actor X must be part of it');
    const fields = await refusal(
      JSON.stringify({ message: 'Validation Failed', errors: [{ code: 'x', message: 'bad' }, 3] }),
    );
    expect(fields.reason).toBe('Validation Failed: bad');
  });

  it('clips a long reason and has none for a body that is not a GitHub error', async () => {
    expect((await refusal(JSON.stringify({ message: 'm'.repeat(300) }))).reason).toHaveLength(200);
    expect((await refusal('<html>')).reason).toBeUndefined();
    expect((await refusal(JSON.stringify({ nope: 1 }))).reason).toBeUndefined();
    const paged = github('t', { fetch: refusing(JSON.stringify({ message: 'Not Found' }), 404) });
    await expect(paged.paginate('repos/o/r/tags')).rejects.toMatchObject({
      message: 'GET repos/o/r/tags: 404',
      reason: 'Not Found',
    });
  });
});

const run = (status: string, conclusion: string | null) => ({ status, conclusion });

describe('stateOf', () => {
  it('is unknown without runs', () => {
    expect(stateOf([])).toBe('unknown');
  });

  it('is green when every run passed, skipped or was neutral', () => {
    expect(
      stateOf([
        run('completed', 'success'),
        run('COMPLETED', 'SKIPPED'),
        run('completed', 'neutral'),
      ]),
    ).toBe('green');
  });

  it('is red as soon as one failed, even while others run', () => {
    for (const conclusion of [
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'STARTUP_FAILURE',
    ]) {
      expect(stateOf([run('in_progress', null), run('completed', conclusion)])).toBe('red');
    }
  });

  it('is pending while any runs and none failed', () => {
    expect(stateOf([run('completed', 'success'), run('queued', null)])).toBe('pending');
    expect(stateOf([run('WAITING', null)])).toBe('pending');
  });

  it('is unknown for a conclusion that says nothing', () => {
    expect(stateOf([run('completed', 'stale')])).toBe('unknown');
    expect(stateOf([run('completed', null)])).toBe('unknown');
  });
});

const checkRunJson = {
  id: 5,
  name: 'talos/review',
  head_sha: 'h',
  status: 'completed',
  conclusion: 'success',
  app: { id: 3, slug: 'talos-reviewer' },
};

describe('check runs', () => {
  it('lists the latest runs on a ref, by name and App', async () => {
    const gh = fakeGitHub({
      [`GET repos/o/r/commits/abc/check-runs?filter=latest&check_name=${encodeURIComponent('talos/review')}`]:
        [
          checkRunJson,
          { ...checkRunJson, id: 6, app: { id: 4, slug: 'impostor' } },
          { ...checkRunJson, id: 7, app: null },
        ],
    });
    const runs = await listCheckRuns(gh, 'o/r', 'abc', {
      name: 'talos/review',
      app: 'talos-reviewer[bot]',
    });
    expect(runs.map((r) => r.id)).toEqual([5]);
  });

  it('lists every run without a filter', async () => {
    const gh = fakeGitHub({
      'GET repos/o/r/commits/main/check-runs?filter=latest': [checkRunJson],
    });
    expect(await listCheckRuns(gh, 'o/r', 'main')).toHaveLength(1);
  });

  it('creates a completed run with its output capped', async () => {
    const calls: Call[] = [];
    const gh = fakeGitHub({ 'POST repos/o/r/check-runs': checkRunJson }, calls);
    const annotations = Array.from({ length: 60 }, (_, i) => ({
      path: 'a.ts',
      start_line: i + 1,
      end_line: i + 1,
      annotation_level: 'failure' as const,
      message: 'm',
    }));
    await createCheckRun(gh, 'o/r', {
      name: 'talos/review',
      headSha: 'h',
      conclusion: 'success',
      completedAt: new Date('2026-10-23T10:00:00Z'),
      externalId: 'x',
      detailsUrl: 'https://example.com',
      output: { title: 'Passed', summary: 's'.repeat(70_000), text: 't', annotations },
    });
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'talos/review',
      head_sha: 'h',
      conclusion: 'success',
      completed_at: '2026-10-23T10:00:00.000Z',
      external_id: 'x',
      details_url: 'https://example.com',
    });
    const output = body.output as { summary: string; annotations: unknown[]; text: string };
    expect(output.summary).toHaveLength(65_535);
    expect(output.annotations).toHaveLength(50);
    expect(output.text).toBe('t');
  });

  it('updates a run with only the fields given', async () => {
    const calls: Call[] = [];
    const gh = fakeGitHub({ 'PATCH repos/o/r/check-runs/5': checkRunJson }, calls);
    await updateCheckRun(gh, 'o/r', 5, {
      status: 'in_progress',
      output: { title: 'T', summary: 'S' },
    });
    expect(calls[0]?.body).toEqual({ status: 'in_progress', output: { title: 'T', summary: 'S' } });
  });

  it('stamps a conclusion with the time when none is given', async () => {
    const calls: Call[] = [];
    const gh = fakeGitHub({ 'PATCH repos/o/r/check-runs/5': checkRunJson }, calls);
    await updateCheckRun(gh, 'o/r', 5, { conclusion: 'failure' });
    expect((calls[0]?.body as { completed_at: string }).completed_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });
});

const runJson = {
  id: 11,
  name: 'Talos gate',
  path: '.github/workflows/gate.yml',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'failure',
  head_sha: 'h',
  head_branch: 'T-1',
  created_at: '2026-10-23T10:00:00Z',
};

describe('workflow runs, jobs and artifacts', () => {
  it('lists one page of runs with the filters given', async () => {
    const gh = fakeGitHub({
      'GET repos/o/r/actions/workflows/gate.yml/runs?per_page=5&head_sha=h&branch=T-1&event=pull_request&status=completed':
        { total_count: 1, workflow_runs: [runJson] },
      'GET repos/o/r/actions/runs?per_page=100': { total_count: 1, workflow_runs: [runJson] },
      'GET repos/o/r/actions/runs?per_page=1': { total_count: 0, workflow_runs: [] },
    });
    const runs = await listWorkflowRuns(gh, 'o/r', {
      workflow: 'gate.yml',
      headSha: 'h',
      branch: 'T-1',
      event: 'pull_request',
      status: 'completed',
      limit: 5,
    });
    expect(runs.map((r) => r.id)).toEqual([11]);
    expect(await listWorkflowRuns(gh, 'o/r', { limit: 500 })).toHaveLength(1);
    expect(await listWorkflowRuns(gh, 'o/r', { limit: 0 })).toEqual([]);
  });

  it("lists a run's jobs and artifacts", async () => {
    const gh = fakeGitHub({
      'GET repos/o/r/actions/runs/11/jobs?filter=latest': [
        { id: 1, run_id: 11, name: 'verdict', status: 'completed', conclusion: 'failure' },
      ],
      'GET repos/o/r/actions/runs/11/artifacts': [
        {
          id: 2,
          name: 'talos-verdict',
          size_in_bytes: 10,
          expired: false,
          archive_download_url: 'u',
        },
      ],
    });
    expect((await listRunJobs(gh, 'o/r', 11))[0]?.name).toBe('verdict');
    expect((await listRunArtifacts(gh, 'o/r', 11))[0]?.name).toBe('talos-verdict');
  });
});

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

describe('downloader', () => {
  it('follows the redirect by hand, without the token', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFake: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: urlOf(input), auth: headers.get('authorization') });
      if (urlOf(input).startsWith('https://api.github.com')) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://blob.example/x?sig=1' },
          }),
        );
      }
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    };
    const bytes = await downloader('secret', { fetch: fetchFake })(
      'repos/o/r/actions/artifacts/2/zip',
    );
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(seen).toEqual([
      { url: 'https://api.github.com/repos/o/r/actions/artifacts/2/zip', auth: 'Bearer secret' },
      { url: 'https://blob.example/x?sig=1', auth: null },
    ]);
  });

  it('reads a direct answer and fails on an error status', async () => {
    const ok: typeof fetch = () => Promise.resolve(new Response(new Uint8Array([9])));
    expect([...(await downloader('t', { fetch: ok })('https://api.github.com/x'))]).toEqual([9]);
    const gone: typeof fetch = () => Promise.resolve(new Response(null, { status: 410 }));
    await expect(downloader('t', { fetch: gone })('x')).rejects.toThrow('GET x: 410');
  });
});

describe('pullsForCommit', () => {
  it('reads the PRs a commit belongs to', async () => {
    const gh = fakeGitHub({
      'GET repos/o/r/commits/abc/pulls': [
        {
          number: 4,
          title: 'Fix',
          body: null,
          state: 'closed',
          merged_at: '2026-10-20T00:00:00Z',
          html_url: 'https://github.com/o/r/pull/4',
          user: { login: 'thea-svp[bot]' },
          base: { ref: 'main' },
        },
      ],
    });
    expect(await pullsForCommit(gh, 'o/r', 'abc')).toEqual([
      {
        number: 4,
        title: 'Fix',
        body: '',
        state: 'closed',
        mergedAt: '2026-10-20T00:00:00Z',
        url: 'https://github.com/o/r/pull/4',
        author: 'thea-svp[bot]',
        base: 'main',
      },
    ]);
  });
});

describe('currentRepository', () => {
  const remote =
    (stdout: string, code = 0): Exec =>
    () =>
      Promise.resolve({ code, stdout, stderr: '' });

  it('prefers GITHUB_REPOSITORY', async () => {
    expect(await currentRepository({ GITHUB_REPOSITORY: 'o/r' }, '.', remote('x'))).toBe('o/r');
  });

  it("reads the origin remote's GitHub repository", async () => {
    expect(await currentRepository({}, '.', remote('git@github.com:SVP-Labs/Thea.git\n'))).toBe(
      'SVP-Labs/Thea',
    );
    expect(await currentRepository({}, '.', remote('https://github.com/SVP-Labs/Talos\n'))).toBe(
      'SVP-Labs/Talos',
    );
  });

  it('is undefined without a GitHub origin', async () => {
    expect(await currentRepository({}, '.', remote('', 2))).toBeUndefined();
    expect(await currentRepository({}, '.', remote('https://gitlab.com/a/b.git'))).toBeUndefined();
    expect(
      await currentRepository({ GITHUB_REPOSITORY: 'not a repo' }, '.', remote('', 1)),
    ).toBeUndefined();
    const broken: Exec = () => Promise.reject(new Error('git could not start'));
    expect(await currentRepository({}, '.', broken)).toBeUndefined();
  });

  it('tells a repository name', () => {
    expect(isRepoName('SVP-Labs/Thea')).toBe(true);
    expect(isRepoName('a/b/c')).toBe(false);
    expect(isRepoName('a b/c')).toBe(false);
  });
});

describe('appId', () => {
  it("reads an App's id by its slug or its bot login", async () => {
    const calls: Call[] = [];
    const gh = fakeGitHub(
      { 'GET apps/talos-reviewer': { id: 5465977, slug: 'talos-reviewer' } },
      calls,
    );
    expect(await appId(gh, 'talos-reviewer[bot]')).toBe(5465977);
    expect(await appId(gh, 'talos-reviewer')).toBe(5465977);
    expect(calls.map((c) => c.path)).toEqual(['apps/talos-reviewer', 'apps/talos-reviewer']);
  });

  it('refuses an answer without a numeric id', async () => {
    const gh = fakeGitHub({ 'GET apps/x': { slug: 'x' } });
    await expect(appId(gh, 'x')).rejects.toThrow();
  });
});
