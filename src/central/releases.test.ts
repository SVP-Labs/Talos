import { describe, expect, it } from 'vitest';
import {
  isAncestor,
  labelledEvents,
  readRegressions,
  readReleases,
  releasesOnBranch,
  tagOf,
} from './releases.js';
import { fakeGitHub } from './test/fake-github.js';

const sha = (c: string): string => c.repeat(40);

const lightweight = (name: string, oid: string, date: string) => ({
  name,
  target: { __typename: 'Commit', oid, committedDate: date },
});
const annotated = (name: string, oid: string, tagged: string | null, committed: string) => ({
  name,
  target: {
    __typename: 'Tag',
    oid: sha('f'),
    tagger: { date: tagged },
    target: { oid, committedDate: committed },
  },
});

function page(nodes: object[], next: string | null) {
  return {
    data: {
      repository: {
        refs: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes },
      },
    },
  };
}

describe('tagOf', () => {
  it('dates a lightweight tag by its commit and an annotated one by its tagger', () => {
    expect(tagOf(lightweight('v1.0.0', sha('a'), 'c1') as never)).toEqual({
      name: 'v1.0.0',
      sha: sha('a'),
      taggedAt: 'c1',
    });
    expect(tagOf(annotated('v1.1.0', sha('b'), 't2', 'c2') as never)).toEqual({
      name: 'v1.1.0',
      sha: sha('b'),
      taggedAt: 't2',
    });
    expect(tagOf(annotated('v1.1.0', sha('b'), null, 'c2') as never)?.taggedAt).toBe('c2');
  });

  it('takes a tag of a tree or of another tag for no release', () => {
    expect(
      tagOf({ name: 'v9.0.0', target: { __typename: 'Tree', oid: sha('c') } }),
    ).toBeUndefined();
  });
});

describe('readReleases', () => {
  it('pages through the tags and keeps the releases, newest first', async () => {
    const pages = [
      page([lightweight('v1.0.0', sha('a'), 'c1'), lightweight('nightly', sha('b'), 'c0')], 'X'),
      page([annotated('v1.1.0', sha('c'), 't2', 'c2')], null),
    ];
    const seen: unknown[] = [];
    const fake = fakeGitHub({
      'POST graphql': (body) => {
        seen.push((body as { variables: unknown }).variables);
        return { body: pages[seen.length - 1] };
      },
    });
    const releases = await readReleases(fake.gh, 'SVP-Labs/Talos');
    expect(releases.map((r) => r.tag)).toEqual(['v1.1.0', 'v1.0.0']);
    expect(seen).toEqual([
      { owner: 'SVP-Labs', name: 'Talos', after: null },
      { owner: 'SVP-Labs', name: 'Talos', after: 'X' },
    ]);
  });
});

describe('ancestry', () => {
  const fake = fakeGitHub({
    [`GET repos/o/t/compare/${sha('a')}...main`]: { body: { status: 'ahead' } },
    [`GET repos/o/t/compare/${sha('b')}...main`]: { body: { status: 'identical' } },
    [`GET repos/o/t/compare/${sha('c')}...main`]: { body: { status: 'diverged' } },
    [`GET repos/o/t/compare/${sha('d')}...main`]: { body: { status: 'behind' } },
  });

  it('finds a commit in the branch when the branch is ahead of it or the same', async () => {
    expect(await isAncestor(fake.gh, 'o/t', sha('a'), 'main')).toBe(true);
    expect(await isAncestor(fake.gh, 'o/t', sha('b'), 'main')).toBe(true);
    expect(await isAncestor(fake.gh, 'o/t', sha('c'), 'main')).toBe(false);
    expect(await isAncestor(fake.gh, 'o/t', sha('d'), 'main')).toBe(false);
  });

  it('keeps the releases on the branch, in order', async () => {
    const release = (c: string, version: string) => ({
      tag: `v${version}`,
      version,
      sha: sha(c),
      taggedAt: 't',
    });
    const releases = [release('c', '1.2.0'), release('a', '1.1.0'), release('b', '1.0.0')];
    const on = await releasesOnBranch(fake.gh, 'o/t', releases, 'main');
    expect(on.map((r) => r.tag)).toEqual(['v1.1.0', 'v1.0.0']);
  });
});

describe('regressions', () => {
  it('reads who put each label on', () => {
    expect(
      labelledEvents([
        {
          event: 'labeled',
          label: { name: 'regression' },
          actor: { login: 'x' },
          created_at: 't1',
        },
        { event: 'labeled', label: { name: 'bug' }, actor: null, created_at: 't2' },
        {
          event: 'unlabeled',
          label: { name: 'regression' },
          actor: { login: 'x' },
          created_at: 't3',
        },
        { event: 'closed', created_at: 't4' },
      ]),
    ).toEqual([
      { label: 'regression', actor: 'x', at: 't1' },
      { label: 'bug', actor: undefined, at: 't2' },
    ]);
  });

  it('keeps the trusted issues and skips pull requests', async () => {
    const issue = (number: number, author: string, extra: object = {}) => ({
      number,
      title: 'Canary broke the gate',
      body: '',
      state: 'open',
      labels: [{ name: 'regression' }],
      user: { login: author },
      created_at: '2026-10-16T00:00:00Z',
      ...extra,
    });
    const fake = fakeGitHub({
      'GET repos/o/t/issues?state=all&labels=regression': {
        body: [
          issue(1, 'SvenPGH'),
          issue(2, 'stranger'),
          issue(3, 'stranger', { pull_request: {} }),
          issue(4, 'stranger', { state: 'closed', state_reason: 'not_planned' }),
        ],
      },
      'GET repos/o/t/issues/1/events': { body: [] },
      'GET repos/o/t/issues/2/events': {
        body: [
          {
            event: 'labeled',
            label: { name: 'regression' },
            actor: { login: 'stranger' },
            created_at: 't',
          },
        ],
      },
      'GET repos/o/t/issues/4/events': {
        body: [
          {
            event: 'labeled',
            label: { name: 'regression' },
            actor: { login: 'thea-svp[bot]' },
            created_at: '2026-10-17T00:00:00Z',
          },
        ],
      },
    });
    const regressions = await readRegressions(fake.gh, 'o/t', ['SvenPGH', 'thea-svp[bot]']);
    expect(regressions).toEqual([
      { number: 1, open: true, dismissed: false, reportedAt: '2026-10-16T00:00:00Z' },
      { number: 4, open: false, dismissed: true, reportedAt: '2026-10-17T00:00:00Z' },
    ]);
    expect(fake.unmatched).toEqual([]);
  });
});
