import { describe, expect, it } from 'vitest';
import {
  canaryWatched,
  leaksIn,
  maskCommands,
  maskNames,
  nameDigest,
  organisationRepositories,
  runPrivacy,
  watchedNames,
} from './privacy.js';
import { fakeGitHub, installation, propertiesPath, propertyValues } from './test/fake-github.js';
import { GitHubError } from '../github/api.js';
import type { Repository } from '../github/repos.js';

/** The organisation's listing: Talos and Scaffold public, Thea and LoreLock private. */
function organisation() {
  return fakeGitHub({
    [propertiesPath('SVP-Labs')]: propertyValues([
      { id: 1, name: 'SVP-Labs/Talos', talos: 'canary' },
      { id: 2, name: 'SVP-Labs/Thea', talos: 'canary' },
      { id: 3, name: 'SVP-Labs/LoreLock', talos: 'stable' },
      { id: 4, name: 'SVP-Labs/Scaffold' },
    ]),
    [propertiesPath('SVP-Labs', 'private')]: propertyValues([
      { id: 2, name: 'SVP-Labs/Thea', talos: 'canary' },
      { id: 3, name: 'SVP-Labs/LoreLock', talos: 'stable' },
    ]),
  });
}

function repo(fullName: string, isPrivate: boolean): Repository {
  return {
    id: 1,
    fullName,
    defaultBranch: 'main',
    archived: false,
    private: isPrivate,
    properties: {},
  };
}

const WATCHED = watchedNames(
  [
    repo('SVP-Labs/Talos', false),
    repo('SVP-Labs/Thea', true),
    repo('SVP-Labs/talos-scratch-canary', true),
    repo('SVP-Labs/Scaffold', false),
    repo('SVP-Labs/Thea', true),
  ],
  'svp-labs/talos',
);

describe('watchedNames', () => {
  it("watches every other repository's full name and each private one's bare name", () => {
    expect(WATCHED).toEqual([
      { fullName: 'SVP-Labs/Thea', name: 'Thea' },
      { fullName: 'SVP-Labs/talos-scratch-canary', name: 'talos-scratch-canary' },
      { fullName: 'SVP-Labs/Scaffold', name: undefined },
    ]);
  });

  it('masks every watched name, full names first', () => {
    expect(maskCommands(WATCHED)).toBe(
      [
        '::add-mask::SVP-Labs/Thea',
        '::add-mask::SVP-Labs/talos-scratch-canary',
        '::add-mask::SVP-Labs/Scaffold',
        '::add-mask::Thea',
        '::add-mask::talos-scratch-canary',
        '',
      ].join('\n'),
    );
  });
});

describe('leaksIn', () => {
  it('finds a full name anywhere and a bare name as a whole word, in any case', () => {
    expect(leaksIn('2026-10-23T00:00:00Z GET repos/svp-labs/scaffold/issues: 404', WATCHED)).toBe(
      1,
    );
    expect(leaksIn('cloning into TALOS-SCRATCH-CANARY...', WATCHED)).toBe(1);
    expect(leaksIn('checked "Thea" and SVP-Labs/Thea', WATCHED)).toBe(1);
    expect(leaksIn('thea, talos-scratch-canary.', WATCHED)).toBe(2);
  });

  it('ignores a bare name inside a longer word, and the public repository itself', () => {
    expect(leaksIn('theatre theatres thea-svp[bot] thea.example _thea', WATCHED)).toBe(0);
    expect(leaksIn('SVP-Labs/Talos at v1.2.0; Scaffold archived', WATCHED)).toBe(0);
    expect(leaksIn('{"schema":"talos.central/1","job":"sweep","ok":true,"filed":1}', WATCHED)).toBe(
      0,
    );
  });
});

describe('organisationRepositories', () => {
  it('lists every repository of the organisation, marking those the private search finds', async () => {
    expect(await organisationRepositories(organisation().gh, 'SVP-Labs')).toEqual([
      { fullName: 'SVP-Labs/Talos', private: false },
      { fullName: 'SVP-Labs/Thea', private: true },
      { fullName: 'SVP-Labs/LoreLock', private: true },
      { fullName: 'SVP-Labs/Scaffold', private: false },
    ]);
  });

  it('keeps a private repository that the first listing missed', async () => {
    const fake = fakeGitHub({
      [propertiesPath('o')]: propertyValues([]),
      [propertiesPath('o', 'private')]: propertyValues([{ id: 9, name: 'o/new' }]),
    });
    expect(await organisationRepositories(fake.gh, 'o')).toEqual([
      { fullName: 'o/new', private: true },
    ]);
  });
});

describe('maskNames', () => {
  function setUp(canary?: string) {
    const out: string[] = [];
    const outputs: string[] = [];
    const deps = {
      properties: organisation().gh,
      org: 'SVP-Labs',
      current: 'SVP-Labs/Talos',
      out: (text: string) => {
        out.push(text);
      },
      canary,
      output: (key: string, value: string) => {
        outputs.push(`${key}=${value}`);
        return Promise.resolve();
      },
    };
    return { deps, out, outputs };
  }

  it("masks every name but the current, then hands on the canary's bare name", async () => {
    const { deps, out, outputs } = setUp(nameDigest('SVP-Labs/LoreLock'));
    expect(await maskNames(deps)).toEqual({ names: 3, canary: true });
    expect(out).toEqual([
      [
        '::add-mask::SVP-Labs/Thea',
        '::add-mask::SVP-Labs/LoreLock',
        '::add-mask::SVP-Labs/Scaffold',
        '::add-mask::Thea',
        '::add-mask::LoreLock',
        '',
      ].join('\n'),
    ]);
    expect(outputs).toEqual(['name=LoreLock']);
  });

  it('hands on nothing without a digest, or for a public repository or none', async () => {
    const unset = setUp();
    expect(await maskNames(unset.deps)).toEqual({ names: 3, canary: null });
    const publicOne = setUp(nameDigest('SVP-Labs/Scaffold'));
    expect(await maskNames(publicOne.deps)).toEqual({ names: 3, canary: false });
    const gone = setUp(nameDigest('SVP-Labs/Gone'));
    expect(await maskNames(gone.deps)).toEqual({ names: 3, canary: false });
    expect([...unset.outputs, ...publicOne.outputs, ...gone.outputs]).toEqual([]);
  });
});

describe('runPrivacy', () => {
  function setUp(logs: Readonly<Record<number, string>>) {
    const canaryToken = fakeGitHub({
      'GET installation/repositories': installation([{ id: 2, name: 'SVP-Labs/Thea' }]),
    });
    const actions = fakeGitHub({
      'GET repos/SVP-Labs/Talos/actions/runs/77/attempts/2/jobs': {
        body: {
          total_count: 5,
          jobs: [
            { id: 1, name: 'list', status: 'completed', conclusion: 'success' },
            { id: 2, name: 'sweep-0', status: 'completed', conclusion: 'failure' },
            { id: 3, name: 'sweep-1', status: 'completed', conclusion: 'skipped' },
            { id: 4, name: 'privacy', status: 'in_progress', conclusion: null },
            { id: 5, name: 'privacy', status: 'completed', conclusion: 'success' },
          ],
        },
      },
    });
    const downloaded: string[] = [];
    const out: string[] = [];
    const download = (path: string): Promise<Uint8Array> => {
      downloaded.push(path);
      const id = Number(/jobs\/(\d+)\/logs$/.exec(path)?.[1]);
      return Promise.resolve(new TextEncoder().encode(logs[id] ?? ''));
    };
    const deps = {
      properties: organisation().gh,
      org: 'SVP-Labs',
      apps: [canaryToken.gh],
      actions: actions.gh,
      download,
      run: { repo: 'SVP-Labs/Talos', id: '77', attempt: '2', self: 'privacy' },
      out: (text: string) => {
        out.push(text);
      },
    };
    return { deps, downloaded, out, canaryToken };
  }

  it("masks first, then searches every finished job's log but its own", async () => {
    const { deps, downloaded, out } = setUp({ 1: 'repositories: 2', 2: 'swept: 1 filed' });
    expect(await runPrivacy(deps)).toEqual({ names: 3, jobs: 2, leaks: 0, canary: null });
    expect(out[0]).toContain('::add-mask::SVP-Labs/Thea\n');
    expect(downloaded).toEqual([
      'repos/SVP-Labs/Talos/actions/jobs/1/logs',
      'repos/SVP-Labs/Talos/actions/jobs/2/logs',
    ]);
  });

  it('counts a leak', async () => {
    const { deps } = setUp({ 2: 'error: GET repos/SVP-Labs/LoreLock/git/trees/main: 500' });
    expect(await runPrivacy(deps)).toEqual({ names: 3, jobs: 2, leaks: 1, canary: null });
  });

  it("confirms the canary by its digest alone, and only when each App's token reaches it alone", async () => {
    const { deps, canaryToken } = setUp({});
    const digest = nameDigest('svp-labs/thea');
    expect(await runPrivacy({ ...deps, canary: digest })).toMatchObject({ canary: true });
    expect(await runPrivacy({ ...deps, canary: nameDigest('SVP-Labs/Gone') })).toMatchObject({
      canary: false,
    });
    expect(await runPrivacy({ ...deps, canary: digest, apps: [] })).toMatchObject({
      canary: false,
    });
    const other = fakeGitHub({
      'GET installation/repositories': installation([{ id: 3, name: 'SVP-Labs/LoreLock' }]),
    });
    expect(
      await runPrivacy({ ...deps, canary: digest, apps: [canaryToken.gh, other.gh] }),
    ).toMatchObject({ canary: false });
    canaryToken.on(
      'GET',
      'installation/repositories',
      installation([
        { id: 2, name: 'SVP-Labs/Thea' },
        { id: 3, name: 'SVP-Labs/LoreLock' },
      ]),
    );
    expect(await runPrivacy({ ...deps, canary: digest })).toMatchObject({ canary: false });
  });
});

describe('canaryWatched', () => {
  it("matches a private repository's digest, never a public one's", () => {
    expect(nameDigest('SVP-Labs/Thea')).toBe(nameDigest('svp-labs/thea'));
    expect(nameDigest('SVP-Labs/Thea')).toMatch(/^[0-9a-f]{64}$/);
    expect(canaryWatched(WATCHED, nameDigest('SVP-Labs/talos-scratch-canary'))).toBe(true);
    expect(canaryWatched(WATCHED, nameDigest('SVP-Labs/Scaffold'))).toBe(false);
  });
});

describe('reading a log GitHub has not stored yet', () => {
  const properties = fakeGitHub({
    [propertiesPath('o')]: propertyValues([{ id: 2, name: 'SVP-Labs/Thea' }]),
    [propertiesPath('o', 'private')]: propertyValues([{ id: 2, name: 'SVP-Labs/Thea' }]),
  });
  const actions = fakeGitHub({
    'GET repos/o/t/actions/runs/1/attempts/1/jobs': {
      body: {
        total_count: 1,
        jobs: [{ id: 9, name: 'drift-0', status: 'completed', conclusion: 'success' }],
      },
    },
  });

  it('tries again after a 404, waiting longer each time, then gives up', async () => {
    const waits: number[] = [];
    let calls = 0;
    const flaky = (): Promise<Uint8Array> => {
      calls += 1;
      return calls < 3
        ? Promise.reject(new GitHubError('GET logs: 404', 404))
        : Promise.resolve(new TextEncoder().encode('SVP-Labs/Thea'));
    };
    const deps = {
      properties: properties.gh,
      org: 'o',
      apps: [],
      actions: actions.gh,
      download: flaky,
      run: { repo: 'o/t', id: '1', attempt: '1', self: 'privacy' },
      out: () => undefined,
      wait: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    };
    expect(await runPrivacy(deps)).toMatchObject({ jobs: 1, leaks: 1 });
    expect(waits).toEqual([5000, 10000]);
    const never = (): Promise<Uint8Array> => Promise.reject(new GitHubError('GET logs: 404', 404));
    await expect(runPrivacy({ ...deps, download: never })).rejects.toThrow('404');
    expect(waits).toHaveLength(5);
    const denied = (): Promise<Uint8Array> => Promise.reject(new GitHubError('GET logs: 403', 403));
    await expect(runPrivacy({ ...deps, download: denied })).rejects.toThrow('403');
    expect(waits).toHaveLength(5);
  });
});
