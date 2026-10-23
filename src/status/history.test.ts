import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitsFor, historySections, leadOf, MAX_COMMITS, whyFor } from './history.js';
import { type GitHub, GitHubError } from '../github/api.js';
import type { Git } from '../repo/git.js';

const TEMPLATE = `<!-- Each section is checked non-empty. -->
## Problem

The claim comment named no run.

## Discussion
<!-- What else was weighed. -->
We could have kept the run URL.

### Rejected

- a database

## Solution

Name the agent and the time.

\`\`\`md
## Problem
inside a fence
\`\`\`

## Checklist

- [x] tests
Closes #41`;

describe('historySections', () => {
  it('reads the three sections of a PR body', () => {
    expect(historySections(TEMPLATE)).toEqual({
      problem: 'The claim comment named no run.',
      discussion: 'We could have kept the run URL.\n\n### Rejected\n\n- a database',
      solution: 'Name the agent and the time.\n\n```md\n## Problem\ninside a fence\n```',
    });
  });

  it('finds sections under any heading level, and ignores closing hashes and case', () => {
    expect(historySections('# Summary\n### PROBLEM ###\nbroken\n# Next\n')).toEqual({
      problem: 'broken',
      discussion: null,
      solution: null,
    });
  });

  it('has null for a missing or empty section', () => {
    expect(historySections('')).toEqual({ problem: null, discussion: null, solution: null });
    expect(historySections('## Problem\n<!-- fill me -->\n\n## Solution\r\nDone.\r\n')).toEqual({
      problem: null,
      discussion: null,
      solution: 'Done.',
    });
  });

  it('keeps one section when its heading repeats', () => {
    expect(historySections('## Problem\na\n## Other\nx\n## Problem\nb').problem).toBe('a\nb');
  });

  it('does not take a heading-like word that is not a heading', () => {
    expect(historySections('#Problem\nx\n    ## Problem\ny').problem).toBeNull();
  });
});

function fakeGitHub(answers: Record<string, unknown>, calls: string[]): GitHub {
  return {
    request: <T>(method: string, path: string) => {
      calls.push(path);
      if (!(`${method} ${path}` in answers)) return Promise.reject(new Error(`unexpected ${path}`));
      return Promise.resolve(answers[`${method} ${path}`] as T);
    },
    paginate: () => Promise.reject(new Error('no pagination')),
    graphql: () => Promise.reject(new Error('no graphql')),
  };
}

function pull(number: number, mergedAt: string | null, body = TEMPLATE): Record<string, unknown> {
  return {
    number,
    title: `PR ${number}`,
    body,
    state: 'closed',
    merged_at: mergedAt,
    html_url: `https://github.com/o/r/pull/${number}`,
    user: { login: 'thea-svp[bot]' },
    base: { ref: 'main' },
  };
}

describe('leadOf', () => {
  it('takes the text before the first heading', () => {
    expect(leadOf('Closes #119. Brief: docs/x.md\n\n## What\nmore')).toBe(
      'Closes #119. Brief: docs/x.md',
    );
    expect(leadOf('<!-- hint -->\n## Problem\nx')).toBeNull();
    expect(leadOf('')).toBeNull();
  });
});

describe('whyFor', () => {
  it('finds the merged PRs behind the commits, newest first, one entry per PR', async () => {
    const calls: string[] = [];
    const gh = fakeGitHub(
      {
        'GET repos/o/r/commits/c1/pulls': [pull(9, '2026-10-22T00:00:00Z')],
        'GET repos/o/r/commits/c2/pulls': [pull(9, '2026-10-22T00:00:00Z'), pull(8, null)],
        'GET repos/o/r/commits/c3/pulls': [],
        'GET repos/o/r/commits/c4/pulls': [pull(5, '2026-10-01T00:00:00Z', 'no sections')],
        'GET repos/o/r/commits/c5/pulls': [pull(4, '2026-09-01T00:00:00Z')],
      },
      calls,
    );
    const entries = await whyFor({ gh, repo: 'o/r', limit: 2 }, ['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(entries).toEqual([
      {
        number: 9,
        title: 'PR 9',
        merged: '2026-10-22T00:00:00Z',
        url: 'https://github.com/o/r/pull/9',
        ...historySections(TEMPLATE),
        summary: null,
      },
      {
        number: 5,
        title: 'PR 5',
        merged: '2026-10-01T00:00:00Z',
        url: 'https://github.com/o/r/pull/5',
        problem: null,
        discussion: null,
        solution: null,
        summary: 'no sections',
      },
    ]);
    expect(calls).not.toContain('repos/o/r/commits/c5/pulls');
  });

  it('skips commits GitHub does not know, and fails on anything else', async () => {
    const gh: GitHub = {
      request: (_method, path) =>
        Promise.reject(
          path.includes('local')
            ? new GitHubError(`GET ${path}: 422`, 422)
            : new GitHubError(`GET ${path}: 500`, 500),
        ),
      paginate: () => Promise.reject(new Error('no pagination')),
      graphql: () => Promise.reject(new Error('no graphql')),
    };
    expect(await whyFor({ gh, repo: 'o/r', limit: 3 }, ['local1', 'local2'])).toEqual([]);
    await expect(whyFor({ gh, repo: 'o/r', limit: 3 }, ['pushed'])).rejects.toThrow('500');
  });

  it('stops within one commit when the limit is reached', async () => {
    const gh = fakeGitHub(
      { 'GET repos/o/r/commits/c1/pulls': [pull(3, 'd'), pull(2, 'd'), pull(1, 'd')] },
      [],
    );
    expect((await whyFor({ gh, repo: 'o/r', limit: 2 }, ['c1'])).map((e) => e.number)).toEqual([
      3, 2,
    ]);
  });
});

/** A program found on PATH, run synchronously; tests only. */
function program(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function hasGit(): boolean {
  try {
    program('git', ['--version'], tmpdir());
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasGit())('commitsFor', () => {
  it('lists the commits that changed a path, following a renamed file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talos-why-test-'));
    const identity = [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
    ];
    const run = (args: readonly string[]): string => program('git', [...identity, ...args], root);
    run(['init', '-q']);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'one']);
    run(['mv', 'src/a.ts', 'src/b.ts']);
    run(['commit', '-q', '-m', 'two']);
    await writeFile(join(root, 'other.ts'), 'x\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'three']);
    const git: Git = { root, run: (args) => Promise.resolve(run(args)) };
    expect(await commitsFor(git, 'src/b.ts', true)).toHaveLength(2);
    expect(await commitsFor(git, 'src/b.ts', false)).toHaveLength(1);
    expect(await commitsFor(git, 'src', false)).toHaveLength(2);
    expect(MAX_COMMITS).toBe(30);
  });
});
