import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { adoptWith, parseOs } from './adopt.js';
import type { Io } from './io.js';
import { main } from './main.js';
import { clone, quietExec, sh } from '../adopt/test/git.js';
import { fakeApi, type FakeApi, json, NOT_FOUND, route } from '../govern/test/fake-api.js';

const NOW = new Date('2026-10-23T10:00:00Z');
const REPO = ['--repo', 'SVP-Labs/demo'];

type Remote = {
  issues: { number: number; body: string; labels: string[] }[];
  comments: Map<number, string[]>;
  pulls: { number: number; head: string }[];
};

function git(origin: string, ...args: string[]): string | undefined {
  try {
    return sh(origin, ...args).trim();
  } catch {
    return undefined;
  }
}

const createIssue = z.object({ title: z.string(), body: z.string(), labels: z.array(z.string()) });
const createRef = z.object({ ref: z.string(), sha: z.string() });

function issueJson(issue: Remote['issues'][number]) {
  return {
    number: issue.number,
    title: 'x',
    body: issue.body,
    state: 'open',
    labels: issue.labels.map((name) => ({ name })),
    user: { login: 'SvenPGH' },
    created_at: '2026-10-01T00:00:00Z',
  };
}

/** GitHub for `SVP-Labs/demo`, whose branches are the bare `origin`'s. */
function github(origin: string, remote: Remote): FakeApi {
  const at = (suffix: string): RegExp => new RegExp(`^repos/SVP-Labs/demo${suffix}$`);
  return fakeApi([
    route('GET', at('/labels'), json([])),
    route('POST', at('/labels'), json({}, 201)),
    route('GET', at(''), json({ id: 1, default_branch: 'main' })),
    route('GET', at('/git/ref/heads/main'), () =>
      json({ ref: 'x', object: { sha: git(origin, 'rev-parse', 'main') } }),
    ),
    route('GET', at('/issues'), () => json(remote.issues.map(issueJson))),
    route('POST', at('/issues'), (call) => {
      const body = createIssue.parse(call.body);
      const issue = { number: remote.issues.length + 1, body: body.body, labels: body.labels };
      remote.issues.push(issue);
      return json(issueJson(issue), 201);
    }),
    route('POST', at('/issues/(\\d+)/labels'), json([])),
    route('GET', at('/issues/(\\d+)/comments'), (_c, m) =>
      json(
        (remote.comments.get(Number(m[1])) ?? []).map((body, id) => ({
          id,
          body,
          user: { login: 'SvenPGH' },
          created_at: 'x',
        })),
      ),
    ),
    route('POST', at('/issues/(\\d+)/comments'), (call, m) => {
      remote.comments.set(Number(m[1]), [z.object({ body: z.string() }).parse(call.body).body]);
      return json({ id: 1 }, 201);
    }),
    route('GET', at('/branches/(.+)'), (_c, m) => {
      const sha = git(origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${m[1] ?? ''}`);
      return sha === undefined
        ? NOT_FOUND
        : json({ commit: { sha, commit: { committer: { date: 'x' } } } });
    }),
    route('POST', at('/git/refs'), (call) => {
      const body = createRef.parse(call.body);
      git(origin, 'branch', body.ref.replace('refs/heads/', ''), body.sha);
      return json({}, 201);
    }),
    route('GET', at('/pulls'), (call) =>
      json(
        remote.pulls
          .filter((p) => call.query.get('head') === `SVP-Labs:${p.head}`)
          .map((p) => ({
            number: p.number,
            state: 'open',
            updated_at: 'x',
            head: { ref: p.head },
          })),
      ),
    ),
    route('GET', at('/compare/main\\.\\.\\.(.+)'), (_c, m) => {
      const ahead = git(origin, 'rev-list', '--count', `main..${m[1] ?? ''}`);
      const files = git(origin, 'diff', '--name-only', `main...${m[1] ?? ''}`)?.split('\n') ?? [];
      return ahead === undefined ? NOT_FOUND : json({ ahead_by: Number(ahead), files });
    }),
    route('POST', at('/pulls'), (call) => {
      remote.pulls.push({ number: 9, head: z.object({ head: z.string() }).parse(call.body).head });
      return json({ number: 9, html_url: 'https://github.com/SVP-Labs/demo/pull/9' }, 201);
    }),
  ]);
}

function io(cwd: string, env: Record<string, string> = { GITHUB_TOKEN: 'token' }) {
  const term = {
    cwd,
    env,
    stdout: '',
    stderr: '',
    out: (text: string) => {
      term.stdout += text;
    },
    err: (text: string) => {
      term.stderr += text;
    },
  } satisfies Io & { stdout: string; stderr: string };
  return term;
}

function remote(): Remote {
  return { issues: [], comments: new Map(), pulls: [] };
}

const parsed = (text: string): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(text));

describe('talos adopt', () => {
  it('prints the plan as compact JSON without a token', async () => {
    const { root } = await clone({ 'package.json': '{}\n', 'index.js': 'export {};\n' });
    const term = io(root, {});
    const run = adoptWith({ exec: quietExec, now: () => NOW });
    expect(await run(['plan', ...REPO, '--json', '--prefix', 'D'], term)).toBe(0);
    const output = parsed(term.stdout);
    expect(output).toMatchObject({
      schema: 'talos.adopt/1',
      step: 'plan',
      name: 'demo',
      prefix: 'D',
      talosYml: 'written',
    });
    expect(output.components).toEqual({
      items: [{ lang: 'ts', root: '.', os: ['linux'] }],
      total: 1,
    });
    expect(output.next).toMatchObject({
      items: [expect.stringContaining('pnpm install --lockfile-only')],
    });
    expect(sh(root, 'status', '--porcelain')).toBe('');
  });

  it('does every step in a clean clone when no lockfile waits, and opens the PR', async () => {
    const { root, origin } = await clone({ 'README.md': '# demo\n' });
    const brief = join(root, '..', 'brief.md');
    await writeFile(brief, '# Demo: what it is for\n');
    const state = remote();
    state.issues.push({ number: 1, body: 'old', labels: [] });
    const api = github(origin, state);
    const run = adoptWith({ fetch: api.fetch, exec: quietExec, packs: [], now: () => NOW });
    const term = io(root);
    expect(await run([...REPO, '--prefix', 'D', '--brief', brief, '--json'], term)).toBe(0);
    expect(parsed(term.stdout)).toMatchObject({
      step: 'adopt',
      issue: 2,
      branch: 'D-2',
      done: true,
      pr: 9,
      legacy: 1,
    });
    expect(git(origin, 'log', '-1', '--format=%s', 'D-2')).toBe('[D-2]: Bring demo under Talos');
    const files = git(origin, 'show', '--name-only', '--format=', 'D-2')?.split('\n') ?? [];
    expect(files).toEqual(
      expect.arrayContaining([
        'talos.yml',
        'CLAUDE.md',
        '.github/dependabot.yml',
        '.githooks/pre-push',
        'docs/requirements/20261023-demo-what-it-is-for.md',
      ]),
    );
    expect(git(origin, 'ls-tree', 'D-2', '--', '.githooks/pre-push')).toMatch(/^100755 /);
    expect(state.issues[0]?.labels).toEqual([]);
    expect(state.comments.get(2)?.[0]).toMatch(/^🔒 claimed by SvenPGH/);
  });

  it('stops before committing when lock files must be refreshed first', async () => {
    const { root, origin } = await clone({
      'package.json': '{\n  "name": "demo"\n}\n',
      'tsconfig.json': '{}\n',
    });
    const run = adoptWith({
      fetch: github(origin, remote()).fetch,
      exec: quietExec,
      now: () => NOW,
    });
    const term = io(root);
    expect(await run([...REPO, '--prefix', 'D', '--json'], term)).toBe(0);
    const output = parsed(term.stdout);
    expect(output).toMatchObject({ done: false, branch: 'D-1' });
    expect(JSON.stringify(output.next)).toContain('talos adopt pr --issue 1');
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toHaveProperty(
      'devDependencies.eslint',
    );
    expect(sh(root, 'branch', '--show-current').trim()).toBe('D-1');
  });

  it('runs as separate steps: start with a token, files without one, pr after the push', async () => {
    const { root, origin } = await clone({ 'README.md': '# demo\n' });
    const state = remote();
    const deps = { fetch: github(origin, state).fetch, exec: quietExec, packs: [], now: () => NOW };
    const start = io(root);
    expect(
      await adoptWith(deps)(
        ['start', ...REPO, '--prefix', 'D', '--agent', 'thea', '--json'],
        start,
      ),
    ).toBe(0);
    expect(parsed(start.stdout)).toMatchObject({
      step: 'start',
      issue: 1,
      branch: 'D-1',
      filed: true,
    });
    sh(root, 'fetch', '--quiet', 'origin', 'D-1:D-1');
    sh(root, 'switch', '--quiet', 'D-1');
    const files = io(root, {});
    expect(await adoptWith(deps)(['files', ...REPO, '--prefix', 'D', '--issue', '1'], files)).toBe(
      0,
    );
    expect(files.stdout).toContain('step: files');
    expect(files.stdout).toContain(
      'git add -A && git update-index --chmod=+x -- .githooks/pre-push && git commit -m',
    );
    sh(root, 'add', '-A');
    sh(root, 'commit', '--quiet', '-m', '[D-1]: Bring demo under Talos');
    sh(root, 'push', '--quiet', 'origin', 'D-1');
    const pr = io(root);
    expect(await adoptWith(deps)(['pr', ...REPO, '--issue', '1', '--json'], pr)).toBe(0);
    expect(parsed(pr.stdout)).toMatchObject({ step: 'pr', issue: 1, pr: 9, opened: true });
  });

  it('refuses a prefix another repository of the organisation uses, before filing anything', async () => {
    const { root, origin } = await clone({ 'README.md': '# demo\n' });
    const state = remote();
    const api = github(origin, state);
    const content = (text: string) =>
      json({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(text).toString('base64'),
        sha: 'x',
      });
    api.routes.unshift(
      route(
        'GET',
        /^orgs\/SVP-Labs\/repos$/,
        json([
          { id: 1, full_name: 'SVP-Labs/demo', default_branch: 'main' },
          { id: 2, full_name: 'SVP-Labs/other', default_branch: 'main' },
        ]),
      ),
      route(
        'GET',
        /^repos\/SVP-Labs\/demo\/contents\/talos\.yml$/,
        content('name: demo\nprefix: D\n'),
      ),
      route('GET', /^repos\/SVP-Labs\/other\/contents\/project\.yml$/, content('prefix: O\n')),
    );
    const deps = { fetch: api.fetch, exec: quietExec, packs: [], now: () => NOW };
    const taken = io(root);
    expect(await adoptWith(deps)(['start', ...REPO, '--prefix', 'O', '--json'], taken)).toBe(1);
    expect(taken.stderr).toBe(
      'talos adopt: prefix O is in use by SVP-Labs/other; each repository needs its own\n',
    );
    expect(api.writes()).toEqual([]);
    const free = io(root);
    expect(await adoptWith(deps)(['start', ...REPO, '--prefix', 'D', '--json'], free)).toBe(0);
    expect(parsed(free.stdout)).toMatchObject({ step: 'start', prefixChecked: true });
  });

  it('goes on unchecked when the token cannot read the organisation', async () => {
    const { root, origin } = await clone({ 'README.md': '# demo\n' });
    const deps = {
      fetch: github(origin, remote()).fetch,
      exec: quietExec,
      packs: [],
      now: () => NOW,
    };
    const term = io(root);
    expect(await adoptWith(deps)(['start', ...REPO, '--prefix', 'D', '--json'], term)).toBe(0);
    expect(parsed(term.stdout)).toMatchObject({ prefixChecked: false });
  });

  it('refuses a dirty tree and a talos.yml it would contradict', async () => {
    const { root, origin } = await clone({
      'talos.yml': 'name: demo\nprefix: D\ncomponents: []\n',
    });
    const run = adoptWith({
      fetch: github(origin, remote()).fetch,
      exec: quietExec,
      now: () => NOW,
    });
    const contradicted = io(root);
    expect(await run(['plan', ...REPO, '--prefix', 'X'], contradicted)).toBe(1);
    expect(contradicted.stderr).toMatch(/already names the prefix D/);
    await writeFile(join(root, 'stray.txt'), 'x');
    const dirty = io(root);
    expect(await run(REPO, dirty)).toBe(1);
    expect(dirty.stderr).toMatch(/working tree has changes/);
  });

  it('checks its arguments', async () => {
    const term = io('/nowhere');
    expect(await main(['adopt', 'nope', ...REPO], term)).toBe(3);
    expect(await main(['adopt', 'files', ...REPO, '--issue', 'x'], term)).toBe(3);
    expect(await main(['adopt', 'plan', ...REPO, '--os', 'ts=dos'], term)).toBe(3);
    expect(await main(['adopt', 'a', 'b'], term)).toBe(3);
    expect(parseOs(['linux,windows', 'rust=windows', 'rust@apps/desktop=macos'])).toEqual([
      { os: ['linux', 'windows'] },
      { lang: 'rust', os: ['windows'] },
      { lang: 'rust', root: 'apps/desktop', os: ['macos'] },
    ]);
    expect(() => parseOs(['go=linux'])).toThrow(/--os go=linux/);
  });
});
