import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheRoot } from './cache.js';
import { enforcedRelease } from './enforced.js';
import { VersionError } from './errors.js';
import { asChannel, lookupMode, pinFinder, selectChannelPin, selectPin } from './pin.js';
import { releaseFromEnvironment, versionAt, versionOf } from './release.js';
import { type GitHub, GitHubError } from '../github/api.js';
import type { Ruleset } from '../github/rulesets.js';

const TALOS_ID = 900;
const PIN = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function ruleset(
  name: string,
  enforcement: string,
  workflows: { repository_id: number; sha?: string; ref?: string; path?: string }[],
): Ruleset {
  return {
    id: name.length,
    name,
    enforcement,
    rules: [
      { type: 'deletion' },
      {
        type: 'workflows',
        parameters: {
          workflows: workflows.map((w) => ({ path: '.github/workflows/gate.yml', ...w })),
        },
      },
    ],
  };
}

describe('selectPin', () => {
  it('takes the one ruleset that runs a Talos workflow', () => {
    const rulesets = [
      ruleset('main-protection', 'active', [{ repository_id: 5, sha: OTHER }]),
      ruleset('talos-canary', 'active', [{ repository_id: TALOS_ID, sha: PIN }]),
    ];
    expect(selectPin(rulesets, TALOS_ID)).toEqual({
      found: true,
      pin: {
        sha: PIN,
        source: 'talos-canary',
        enforcement: 'active',
        path: '.github/workflows/gate.yml',
        channel: 'canary',
      },
    });
  });

  it('counts a ruleset in Evaluate mode and skips a disabled one', () => {
    const rulesets = [
      ruleset('talos-stable', 'disabled', [{ repository_id: TALOS_ID, sha: OTHER }]),
      ruleset('talos-evaluate', 'evaluate', [{ repository_id: TALOS_ID, sha: PIN }]),
    ];
    const lookup = selectPin(rulesets, TALOS_ID);
    expect(lookup).toMatchObject({
      found: true,
      pin: { sha: PIN, channel: 'evaluate', enforcement: 'evaluate' },
    });
  });

  it('has no channel for a ruleset named otherwise', () => {
    const lookup = selectPin(
      [ruleset('gate', 'active', [{ repository_id: TALOS_ID, sha: PIN }])],
      TALOS_ID,
    );
    expect(lookup).toMatchObject({ found: true, pin: { channel: null } });
    const odd = selectPin(
      [ruleset('talos-nightly', 'active', [{ repository_id: TALOS_ID, sha: PIN }])],
      TALOS_ID,
    );
    expect(odd).toMatchObject({ found: true, pin: { channel: null } });
  });

  it('accepts the same pin required twice by one ruleset', () => {
    const twice = ruleset('talos-canary', 'active', [
      { repository_id: TALOS_ID, sha: PIN },
      { repository_id: TALOS_ID, sha: PIN, path: '.github/workflows/other.yml' },
    ]);
    expect(selectPin([twice], TALOS_ID)).toMatchObject({ found: true, pin: { sha: PIN } });
  });

  it('finds nothing when no ruleset runs Talos', () => {
    expect(selectPin([], TALOS_ID)).toEqual({
      found: false,
      reason: 'no ruleset that applies to this repository runs the Talos gate',
    });
    expect(
      selectPin([ruleset('x', 'active', [{ repository_id: 1, sha: PIN }])], TALOS_ID).found,
    ).toBe(false);
  });

  it('refuses several Talos rulesets', () => {
    const rulesets = [
      ruleset('talos-canary', 'active', [{ repository_id: TALOS_ID, sha: PIN }]),
      ruleset('talos-stable', 'evaluate', [{ repository_id: TALOS_ID, sha: PIN }]),
    ];
    expect(selectPin(rulesets, TALOS_ID)).toEqual({
      found: false,
      reason: '2 Talos rulesets apply (talos-canary, talos-stable); exactly one must',
    });
  });

  it('refuses a ruleset pinning two commits', () => {
    const split = ruleset('talos-canary', 'active', [
      { repository_id: TALOS_ID, sha: PIN },
      { repository_id: TALOS_ID, sha: OTHER },
    ]);
    expect(selectPin([split], TALOS_ID)).toEqual({
      found: false,
      reason: 'ruleset talos-canary pins Talos at 2 different commits',
    });
  });

  it('refuses a workflow run at a ref or a malformed SHA', () => {
    for (const workflow of [
      { repository_id: TALOS_ID, ref: 'refs/tags/v1.0.0' },
      { repository_id: TALOS_ID, sha: 'abc' },
      { repository_id: TALOS_ID, sha: PIN.toUpperCase() },
    ]) {
      expect(selectPin([ruleset('talos-canary', 'active', [workflow])], TALOS_ID)).toEqual({
        found: false,
        reason: 'ruleset talos-canary runs Talos at a ref, not a commit SHA',
      });
    }
  });
});

describe('selectChannelPin', () => {
  const channels = { evaluate: OTHER, canary: PIN, stable: OTHER };

  it("maps the repository's channel to its commit", () => {
    expect(selectChannelPin('canary', channels)).toEqual({
      found: true,
      pin: {
        sha: PIN,
        source: 'channels.json',
        enforcement: 'active',
        path: null,
        channel: 'canary',
      },
    });
    expect(selectChannelPin('evaluate', channels)).toMatchObject({
      pin: { enforcement: 'evaluate', sha: OTHER },
    });
  });

  it('needs the property, a channel, and a complete file', () => {
    expect(selectChannelPin(undefined, channels)).toEqual({
      found: false,
      reason: 'the repository has no `talos` property',
    });
    expect(selectChannelPin('nightly', channels)).toEqual({
      found: false,
      reason: 'the `talos` property is "nightly", not a channel',
    });
    for (const file of [undefined, {}, { ...channels, stable: 'v1.0.0' }]) {
      expect(selectChannelPin('canary', file)).toEqual({
        found: false,
        reason: 'channels.json does not map every channel to a commit',
      });
    }
  });
});

describe('lookupMode and asChannel', () => {
  it('reads TALOS_LOOKUP', () => {
    expect(lookupMode({})).toBe('rulesets');
    expect(lookupMode({ TALOS_LOOKUP: '' })).toBe('rulesets');
    expect(lookupMode({ TALOS_LOOKUP: 'rulesets' })).toBe('rulesets');
    expect(lookupMode({ TALOS_LOOKUP: 'channels' })).toBe('channels');
    expect(() => lookupMode({ TALOS_LOOKUP: 'branch' })).toThrow('TALOS_LOOKUP must be');
  });

  it('knows the three channels', () => {
    expect(asChannel('stable')).toBe('stable');
    expect(asChannel('Stable')).toBeNull();
    expect(asChannel(undefined)).toBeNull();
  });
});

function fakeGitHub(answers: Record<string, unknown>, calls: string[] = []): GitHub {
  const answer = (key: string): unknown => {
    if (!(key in answers)) throw new Error(`unexpected ${key}`);
    const value = answers[key];
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    request: <T>(method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return Promise.resolve(answer(`${method} ${path}`) as T);
    },
    paginate: <T>(path: string) => {
      calls.push(`GET ${path}`);
      return Promise.resolve(answer(`GET ${path}`) as T[]);
    },
    graphql: () => Promise.reject(new Error('no graphql')),
  };
}

const manifest = (version: string, name = '@svp-labs/talos') => ({
  type: 'file',
  encoding: 'base64',
  content: Buffer.from(JSON.stringify({ name, version })).toString('base64'),
  sha: 'blob',
});

function lookupAnswers(): Record<string, unknown> {
  return {
    'GET repos/SVP-Labs/Talos': { id: TALOS_ID, full_name: 'SVP-Labs/Talos' },
    'GET repos/o/r/rulesets?includes_parents=true': [
      { id: 1, name: 'talos-canary', enforcement: 'active' },
      { id: 2, name: 'old', enforcement: 'disabled' },
    ],
    'GET repos/o/r/rulesets/1?includes_parents=true': ruleset('talos-canary', 'active', [
      { repository_id: TALOS_ID, sha: PIN },
    ]),
    [`GET repos/SVP-Labs/Talos/contents/package.json?ref=${PIN}`]: manifest('1.2.0'),
  };
}

describe('pinFinder', () => {
  it('reads only the rulesets that are not disabled, and the Talos id once', async () => {
    const calls: string[] = [];
    const find = pinFinder(fakeGitHub(lookupAnswers(), calls), 'SVP-Labs/Talos', 'rulesets');
    expect(await find('o/r')).toMatchObject({ found: true, pin: { sha: PIN } });
    expect(
      await find({
        id: 3,
        fullName: 'o/r',
        defaultBranch: 'main',
        archived: false,
        private: false,
        properties: {},
      }),
    ).toMatchObject({ found: true });
    expect(calls.filter((c) => c === 'GET repos/SVP-Labs/Talos')).toHaveLength(1);
    expect(calls).not.toContain('GET repos/o/r/rulesets/2?includes_parents=true');
  });

  it("reads channels.json once and each repository's property", async () => {
    const calls: string[] = [];
    const gh = fakeGitHub(
      {
        'GET repos/o/r': { id: 3, full_name: 'o/r', custom_properties: { talos: 'stable' } },
        'GET repos/SVP-Labs/Talos/contents/channels.json?ref=channels': {
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(
            JSON.stringify({ evaluate: PIN, canary: OTHER, stable: PIN }),
          ).toString('base64'),
          sha: 'c',
        },
      },
      calls,
    );
    const find = pinFinder(gh, 'SVP-Labs/Talos', 'channels');
    expect(await find('o/r')).toMatchObject({ found: true, pin: { sha: PIN, channel: 'stable' } });
    const known = {
      id: 4,
      fullName: 'o/s',
      defaultBranch: 'main',
      archived: false,
      private: false,
      properties: { talos: 'canary' },
    };
    expect(await find(known)).toMatchObject({ found: true, pin: { sha: OTHER } });
    expect(calls.filter((c) => c.includes('channels.json'))).toHaveLength(1);
  });

  it('reports a channels.json that is not JSON, or missing, as incomplete', async () => {
    const broken = fakeGitHub({
      'GET repos/SVP-Labs/Talos/contents/channels.json?ref=channels': {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('{ nope').toString('base64'),
        sha: 'c',
      },
    });
    const repo = {
      id: 4,
      fullName: 'o/s',
      defaultBranch: 'main',
      archived: false,
      private: false,
      properties: { talos: 'canary' },
    };
    expect(await pinFinder(broken, 'SVP-Labs/Talos', 'channels')(repo)).toMatchObject({
      found: false,
    });
    const missing = fakeGitHub({
      'GET repos/SVP-Labs/Talos/contents/channels.json?ref=channels': undefined,
    });
    expect(await pinFinder(missing, 'SVP-Labs/Talos', 'channels')(repo)).toMatchObject({
      found: false,
    });
  });
});

describe('pinFinder failures', () => {
  it('rejects once, with nothing left unhandled, when the rulesets cannot be read', async () => {
    const gh = fakeGitHub({
      'GET repos/SVP-Labs/Talos': new GitHubError('GET repos/SVP-Labs/Talos: 401', 401),
      'GET repos/o/r/rulesets?includes_parents=true': new GitHubError('GET rulesets: 401', 401),
    });
    const rejected: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejected.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      await expect(pinFinder(gh, 'SVP-Labs/Talos', 'rulesets')('o/r')).rejects.toBeInstanceOf(
        GitHubError,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(rejected).toEqual([]);
  });
});

describe('versions', () => {
  it("reads Talos's version from a package.json", () => {
    expect(versionOf(JSON.stringify({ name: '@svp-labs/talos', version: '1.2.0-rc.1' }))).toBe(
      '1.2.0-rc.1',
    );
    expect(versionOf(JSON.stringify({ name: 'other', version: '1.2.0' }))).toBeUndefined();
    expect(
      versionOf(JSON.stringify({ name: '@svp-labs/talos', version: '^1.2.0' })),
    ).toBeUndefined();
    expect(versionOf('{')).toBeUndefined();
  });

  it('reads the version at a pinned commit', async () => {
    const gh = fakeGitHub(lookupAnswers());
    expect(await versionAt(gh, 'SVP-Labs/Talos', PIN)).toBe('1.2.0');
  });

  it("refuses a commit whose package.json isn't Talos's", async () => {
    const gh = fakeGitHub({
      [`GET repos/SVP-Labs/Talos/contents/package.json?ref=${OTHER}`]: manifest('1.0.0', 'evil'),
      [`GET repos/SVP-Labs/Talos/contents/package.json?ref=${PIN}`]: undefined,
    });
    await expect(versionAt(gh, 'SVP-Labs/Talos', OTHER)).rejects.toThrow(VersionError);
    await expect(versionAt(gh, 'SVP-Labs/Talos', PIN)).rejects.toThrow(`at ${PIN.slice(0, 12)}`);
  });

  it('takes TALOS_VERSION and TALOS_SHA only together and well formed', () => {
    expect(releaseFromEnvironment({})).toBeUndefined();
    expect(releaseFromEnvironment({ TALOS_VERSION: '', TALOS_SHA: '' })).toBeUndefined();
    expect(releaseFromEnvironment({ TALOS_VERSION: '1.2.0', TALOS_SHA: PIN })).toEqual({
      version: '1.2.0',
      sha: PIN,
    });
    for (const env of [
      { TALOS_VERSION: '1.2.0' },
      { TALOS_SHA: PIN },
      { TALOS_VERSION: 'latest', TALOS_SHA: PIN },
      { TALOS_VERSION: '1.2.0', TALOS_SHA: 'v1.2.0' },
    ]) {
      expect(() => releaseFromEnvironment(env)).toThrow(VersionError);
    }
  });
});

describe('enforcedRelease', () => {
  it("takes the hub's version without any lookup", async () => {
    const release = await enforcedRelease({
      env: { TALOS_VERSION: '1.2.0', TALOS_SHA: PIN },
      repo: undefined,
      client: () => {
        throw new Error('no client expected');
      },
    });
    expect(release).toEqual({ version: '1.2.0', sha: PIN, from: 'environment' });
  });

  it("looks up the repository's pin and its version", async () => {
    const release = await enforcedRelease({
      env: { GITHUB_TOKEN: 't' },
      repo: 'o/r',
      client: () => fakeGitHub(lookupAnswers()),
    });
    expect(release).toMatchObject({
      version: '1.2.0',
      sha: PIN,
      from: 'rulesets',
      pin: { source: 'talos-canary' },
    });
  });

  it('explains what is missing', async () => {
    await expect(enforcedRelease({ env: { GITHUB_TOKEN: 't' }, repo: undefined })).rejects.toThrow(
      'no GitHub repository here',
    );
    const none = { ...lookupAnswers(), 'GET repos/o/r/rulesets?includes_parents=true': [] };
    await expect(
      enforcedRelease({ env: { GITHUB_TOKEN: 't' }, repo: 'o/r', client: () => fakeGitHub(none) }),
    ).rejects.toThrow(
      'o/r: no ruleset that applies to this repository runs the Talos gate; run `talos doctor`',
    );
  });

  it("turns the API's refusals into advice", async () => {
    const failing = (status: number) => () =>
      fakeGitHub({
        'GET repos/SVP-Labs/Talos': new GitHubError(`GET repos/SVP-Labs/Talos: ${status}`, status),
        'GET repos/o/r/rulesets?includes_parents=true': [],
      });
    const cases: [number, string][] = [
      [401, 'the GitHub token was refused'],
      [403, "the token can't read o/r's rulesets"],
      [404, "the token can't read o/r's rulesets"],
      [500, 'GitHub failed while finding the enforced version'],
    ];
    for (const [status, message] of cases) {
      await expect(
        enforcedRelease({ env: { GITHUB_TOKEN: 't' }, repo: 'o/r', client: failing(status) }),
      ).rejects.toThrow(message);
    }
  });
});

describe('cacheRoot', () => {
  it('honours TALOS_CACHE, then the platform', () => {
    expect(cacheRoot({ TALOS_CACHE: '/c' }, 'linux', '/h')).toBe('/c');
    expect(cacheRoot({}, 'linux', '/h')).toBe(join('/h', '.cache', 'talos'));
    expect(cacheRoot({ XDG_CACHE_HOME: '/x' }, 'linux', '/h')).toBe(join('/x', 'talos'));
    expect(cacheRoot({ XDG_CACHE_HOME: '' }, 'linux', '/h')).toBe(join('/h', '.cache', 'talos'));
    expect(cacheRoot({}, 'darwin', '/h')).toBe(join('/h', 'Library', 'Caches', 'talos'));
    expect(cacheRoot({ LOCALAPPDATA: 'L' }, 'win32', '/h')).toBe(join('L', 'talos', 'cache'));
    expect(cacheRoot({}, 'win32', '/h')).toBe(join('/h', 'AppData', 'Local', 'talos', 'cache'));
  });
});
