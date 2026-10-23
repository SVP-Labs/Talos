import { describe, expect, it } from 'vitest';
import { judgeReadiness } from './readiness.js';
import { keepSyncChore, staleCopies, syncChore, syncPlan } from './sync-chore.js';
import { readMarker, type TalosIssue } from './talos-issues.js';
import { finding, reportOf } from './test/findings.js';
import { identities } from '../github/identities.js';
import { affectedPaths } from '../ticket/sections.js';
import { FakeGitHub } from '../ticket/test/fake-github.js';

const who = identities({});

function drift(file: string): ReturnType<typeof finding> {
  return finding('config/drift', file, { check: 'configs/drift' });
}

function chore(
  files: string[],
  labels: string[] = [],
  state: 'open' | 'closed' = 'open',
): TalosIssue {
  return {
    number: 9,
    title: '',
    body: syncChore(files).body,
    state,
    stateReason: undefined,
    labels,
    author: who.reviewer,
    association: 'NONE',
    createdAt: '',
    closedAt: undefined,
    isPull: false,
    fields: {},
  };
}

describe('staleCopies', () => {
  it('lists each stale generated copy once, sorted', () => {
    const report = reportOf([
      drift('tsconfig.talos.json'),
      drift('eslint.config.js'),
      drift('eslint.config.js'),
      finding('r/1', 'src/a.ts'),
    ]);
    expect(staleCopies(report)).toEqual(['eslint.config.js', 'tsconfig.talos.json']);
  });
});

describe('syncChore', () => {
  it('is a ready chore naming exactly the stale copies', () => {
    const draft = syncChore(['eslint.config.js', 'ruff.toml']);
    expect(draft.title).toBe('Sync 2 generated configs with the enforced Talos version');
    expect(draft.labels).toEqual(['chore', 'sync', 'status/ready', 'ai/eligible', 'priority/p3']);
    expect(affectedPaths(draft.body)).toEqual(['eslint.config.js', 'ruff.toml']);
    expect(readMarker(draft.body, 'sync')).toEqual({ files: '2' });
    expect(
      judgeReadiness({ body: draft.body, labels: draft.labels, briefsDir: 'd', briefs: new Map() })
        .ready,
    ).toBe(true);
    expect(syncChore(['a.js']).title).toBe(
      'Sync 1 generated config with the enforced Talos version',
    );
  });
});

describe('syncPlan', () => {
  it('files one when copies are stale and none is open', () => {
    expect(syncPlan([], [])).toEqual({ action: 'none' });
    expect(syncPlan(['a.js'], [])).toEqual({ action: 'create' });
    expect(syncPlan(['a.js'], [chore(['a.js'], [], 'closed')])).toEqual({ action: 'create' });
  });

  it('keeps an open one current unless someone holds it', () => {
    expect(syncPlan(['a.js', 'b.js'], [chore(['a.js', 'b.js'])])).toEqual({
      action: 'current',
    });
    expect(syncPlan(['a.js', 'c.js'], [chore(['a.js', 'b.js'])])).toEqual({
      action: 'update',
      issue: 9,
    });
    expect(syncPlan(['a.js'], [chore(['a.js', 'b.js'], ['ai/claimed'])])).toEqual({
      action: 'claimed',
    });
  });
});

describe('keepSyncChore', () => {
  it('files, then updates, the one sync chore', async () => {
    const fake = new FakeGitHub();
    const gh = fake.client();
    expect(await keepSyncChore(gh, { repo: 'o/r', who }, reportOf([drift('a.js')]))).toEqual({
      action: 'create',
    });
    expect(await keepSyncChore(gh, { repo: 'o/r', who }, reportOf([drift('a.js')]))).toEqual({
      action: 'current',
    });
    expect(
      await keepSyncChore(gh, { repo: 'o/r', who }, reportOf([drift('a.js'), drift('b.js')])),
    ).toEqual({
      action: 'update',
      issue: 1,
    });
    expect(affectedPaths(fake.issues.get(1)?.body ?? '')).toEqual(['a.js', 'b.js']);
    expect(fake.issues.size).toBe(1);
  });
});
