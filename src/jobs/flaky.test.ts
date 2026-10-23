import { describe, expect, it } from 'vitest';
import {
  fileFlakyIssues,
  flakyCandidates,
  flakyIn,
  flakyIssue,
  type FlakySighting,
  unfiled,
} from './flaky.js';
import { judgeReadiness } from './readiness.js';
import { digest, readMarker, type TalosIssue } from './talos-issues.js';
import { downloader } from '../github/artifacts.js';
import { identities } from '../github/identities.js';
import { affectedPaths } from '../ticket/sections.js';
import { FakeGitHub, makeZip } from '../ticket/test/fake-github.js';

const who = identities({});

function verdict(flaky: { id: string; file: string | null }[], pr: number | null = 12): string {
  return JSON.stringify({ schema: 'talos.verdict/1', repo: 'o/r', pr, status: 'green', flaky });
}

function sighting(
  id: string,
  seenAt: string,
  file: string | null = 'test/a.test.ts',
): FlakySighting {
  return { id, file, seenAt, pr: null };
}

function issueFor(test: string, state: 'open' | 'closed', closedAt?: string): TalosIssue {
  return {
    number: 1,
    title: '',
    body: '',
    state,
    stateReason: undefined,
    labels: ['flaky'],
    author: who.reviewer,
    association: 'NONE',
    createdAt: '',
    closedAt,
    isPull: false,
    fields: { test: digest(test) },
  };
}

describe('flakyIn', () => {
  it("reads the verdict's flaky list", () => {
    expect(flakyIn(verdict([{ id: 'a > b', file: 'test/a.test.ts' }]), 'T')).toEqual([
      { id: 'a > b', file: 'test/a.test.ts', seenAt: 'T', pr: 12 },
    ]);
  });

  it('refuses anything that is not a verdict', () => {
    expect(() => flakyIn('{"schema":"talos.status/1","flaky":[]}', 'T')).toThrow();
    expect(() => flakyIn('nope', 'T')).toThrow();
  });
});

describe('flakyCandidates', () => {
  it('keeps the latest sighting of each test with a file', () => {
    const candidates = flakyCandidates([
      sighting('b', '2026-10-24T00:00:00Z'),
      sighting('a', '2026-10-24T00:00:00Z', 'test/old.ts'),
      sighting('a', '2026-10-25T00:00:00Z', 'test/new.ts'),
      sighting('a', '2026-10-23T00:00:00Z', 'test/older.ts'),
      sighting('c', '2026-10-25T00:00:00Z', null),
      sighting('d', '2026-10-25T00:00:00Z', 'has space.ts'),
    ]);
    expect(candidates.map((c) => [c.id, c.file, c.seenAt])).toEqual([
      ['a', 'test/new.ts', '2026-10-25T00:00:00Z'],
      ['b', 'test/a.test.ts', '2026-10-24T00:00:00Z'],
    ]);
    expect(candidates[0]?.digest).toBe(digest('a'));
  });
});

describe('unfiled', () => {
  const candidates = flakyCandidates([
    sighting('a', '2026-10-24T00:00:00Z'),
    sighting('b', '2026-10-24T00:00:00Z'),
  ]);

  it('skips a test with an open issue', () => {
    expect(unfiled(candidates, [issueFor('a', 'open')]).map((c) => c.id)).toEqual(['b']);
  });

  it('skips a sighting from before its issue was closed, not one from after', () => {
    expect(
      unfiled(candidates, [issueFor('a', 'closed', '2026-10-25T00:00:00Z')]).map((c) => c.id),
    ).toEqual(['b']);
    expect(
      unfiled(candidates, [issueFor('a', 'closed', '2026-10-23T00:00:00Z')]).map((c) => c.id),
    ).toEqual(['a', 'b']);
  });
});

describe('flakyIssue', () => {
  it('is a ready bug naming the test file', () => {
    const [candidate] = flakyCandidates([
      { ...sighting('suite > it works', '2026-10-24T05:00:00Z'), pr: 3 },
    ]);
    if (candidate === undefined) throw new Error('no candidate');
    const draft = flakyIssue(candidate);
    expect(draft.title).toBe('Flaky test: suite > it works');
    expect(draft.labels).toEqual(['bug', 'flaky', 'status/ready', 'ai/eligible', 'priority/p2']);
    expect(readMarker(draft.body, 'flaky')).toEqual({
      test: digest('suite > it works'),
      file: 'test/a.test.ts',
    });
    expect(affectedPaths(draft.body)).toEqual(['test/a.test.ts']);
    expect(draft.body).toContain('last on 2026-10-24 (on PR #3)');
    expect(
      judgeReadiness({ body: draft.body, labels: draft.labels, briefsDir: 'd', briefs: new Map() })
        .ready,
    ).toBe(true);
  });

  it('clips a long test name in the title', () => {
    const [candidate] = flakyCandidates([sighting('x'.repeat(200), '2026-10-24T00:00:00Z')]);
    if (candidate === undefined) throw new Error('no candidate');
    expect(flakyIssue(candidate).title).toHaveLength('Flaky test: '.length + 80);
  });
});

describe('fileFlakyIssues', () => {
  function setUp(): FakeGitHub {
    const fake = new FakeGitHub();
    const add = (id: number, created: string, body: string): void => {
      fake.artifacts.push({
        id,
        name: 'talos-verdict',
        created_at: created,
        expired: false,
        size_in_bytes: 100,
        zip: makeZip({ 'verdict.json': body }),
      });
    };
    add(
      1,
      '2026-10-25T00:00:00Z',
      verdict([
        { id: 'a', file: 'test/a.test.ts' },
        { id: 'gone', file: 'test/gone.test.ts' },
      ]),
    );
    add(2, '2026-10-25T01:00:00Z', verdict([{ id: 'a', file: 'test/a.test.ts' }]));
    add(3, '2026-10-25T02:00:00Z', 'not json');
    add(4, '2026-10-01T00:00:00Z', verdict([{ id: 'old', file: 'test/a.test.ts' }]));
    fake.files.set('test/a.test.ts', 'it()');
    return fake;
  }

  it('files one issue per flaky test still on the default branch, once', async () => {
    const fake = setUp();
    const deps = {
      gh: fake.client(),
      actions: fake.client('github-actions[bot]'),
      download: downloader('w', { fetch: fake.fetch }),
    };
    const at = { repo: 'o/r', who, now: new Date('2026-10-26T03:17:00Z'), base: 'main' };
    expect(await fileFlakyIssues(deps, at)).toEqual({ filed: 1, seen: 2, unreadable: 1 });
    expect([...fake.issues.values()].map((i) => i.title)).toEqual(['Flaky test: a']);
    expect(await fileFlakyIssues(deps, at)).toEqual({ filed: 0, seen: 2, unreadable: 1 });
  });

  it('files nothing when no verdict reports a flaky test', async () => {
    const fake = new FakeGitHub();
    const deps = {
      gh: fake.client(),
      actions: fake.client(),
      download: downloader('w', { fetch: fake.fetch }),
    };
    const at = { repo: 'o/r', who, now: new Date('2026-10-26T03:17:00Z'), base: 'main' };
    expect(await fileFlakyIssues(deps, at)).toEqual({ filed: 0, seen: 0, unreadable: 0 });
  });
});
