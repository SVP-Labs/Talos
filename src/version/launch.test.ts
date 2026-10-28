import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VersionError } from './errors.js';
import {
  auditProblems,
  binIn,
  ensureVerified,
  entryFor,
  type Installed,
  lockedIntegrity,
  MARKER,
} from './install.js';
import {
  isVerifiedInstall,
  launch,
  LAUNCHED_COMMANDS,
  type LaunchDeps,
  launchWith,
  needsLaunch,
  repoArgument,
  runNode,
} from './launch.js';
import { packageUrl, SLSA_PROVENANCE_V1 } from './provenance.js';
import type { Release } from './release.js';
import { ownBuild, ownInstallMarker, ownVersion, requiredNode } from './self.js';
import type { Exec } from '../exec/exec.js';

const SHA = 'c'.repeat(40);
const RELEASE: Release = { version: '1.2.0', sha: SHA };
const DIGEST = Buffer.alloc(64, 3);
const INTEGRITY = `sha512-${DIGEST.toString('base64')}`;
const AUDIT_RACED = JSON.stringify({
  invalid: [{ code: 'EATTESTATIONVERIFY', name: '@sigstore/core', version: '3.1.0' }],
  missing: [],
});

function quiet(): void {
  // The installer's log, unread.
}

function attestationsFor(commit: string, digest: Buffer = DIGEST): unknown {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      { name: packageUrl('@svp-labs/talos', '1.2.0'), digest: { sha512: digest.toString('hex') } },
    ],
    predicateType: SLSA_PROVENANCE_V1,
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: 'refs/tags/v1.2.0',
            repository: 'https://github.com/SVP-Labs/Talos',
            path: 'release.yml',
          },
        },
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/SVP-Labs/Talos@refs/tags/v1.2.0',
            digest: { gitCommit: commit },
          },
        ],
      },
    },
  };
  return {
    attestations: [
      {
        predicateType: SLSA_PROVENANCE_V1,
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
            payloadType: 'application/vnd.in-toto+json',
          },
        },
      },
    ],
  };
}

function lockfile(version: string, integrity: string): string {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/@svp-labs/talos': { version, integrity } },
  });
}

type FakeNpm = { exec: Exec; calls: string[] };

/**
 * npm as far as the installer sees it: install writes the package, its lockfile and its cache;
 * each audit answers with the next of `audits`, the last one again once they run out. A call
 * with a cache of the run's own records it as `--cache <own>`.
 */
function fakeNpm(
  options: { installCode?: number; audit?: string; audits?: string[]; integrity?: string } = {},
): FakeNpm {
  const calls: string[] = [];
  const audits = options.audits ?? [options.audit ?? '{"invalid":[],"missing":[]}'];
  let audited = 0;
  const exec: Exec = async (command, args, { cwd }) => {
    const own = args.at(-2) === '--cache' && args.at(-1) === join(cwd, 'npm-cache');
    calls.push(`${command} ${(own ? [...args.slice(0, -2), '--cache', '<own>'] : args).join(' ')}`);
    if (args[0] === 'install') {
      if ((options.installCode ?? 0) !== 0) {
        return { code: options.installCode ?? 1, stdout: '', stderr: 'E404' };
      }
      await mkdir(join(cwd, 'npm-cache', '_tuf'), { recursive: true });
      await mkdir(dirname(binIn(cwd)), { recursive: true });
      await writeFile(binIn(cwd), 'process.exit(0)\n');
      await writeFile(
        join(cwd, 'package-lock.json'),
        lockfile('1.2.0', options.integrity ?? INTEGRITY),
      );
      return { code: 0, stdout: '', stderr: '' };
    }
    const audit = audits[Math.min(audited, audits.length - 1)] ?? '';
    audited += 1;
    return { code: audit.includes('"invalid":[]') ? 0 : 1, stdout: audit, stderr: '' };
  };
  return { exec, calls };
}

function registry(response: unknown, status = 200): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (input) => {
      urls.push(typeof input === 'string' ? input : 'other');
      return Promise.resolve(new Response(JSON.stringify(response), { status }));
    },
  };
}

async function cache(): Promise<Record<string, string>> {
  return { TALOS_CACHE: await mkdtemp(join(tmpdir(), 'talos-cache-test-')) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('ensureVerified', () => {
  it('installs, verifies and marks the release, then reuses it without npm', async () => {
    const env = await cache();
    const npm = fakeNpm();
    const reg = registry(attestationsFor(SHA));
    const installed = await ensureVerified(RELEASE, {
      exec: npm.exec,
      fetch: reg.fetch,
      env,
      log: quiet,
    });
    const root = entryFor(env.TALOS_CACHE ?? '', RELEASE);
    expect(installed).toEqual({ ...RELEASE, integrity: INTEGRITY, root, bin: binIn(root) });
    expect(npm.calls).toEqual([
      'npm install --ignore-scripts --no-audit --no-fund --save-exact @svp-labs/talos@1.2.0 --cache <own>',
      'npm audit signatures --json --cache <own>',
    ]);
    expect(await exists(join(root, 'npm-cache'))).toBe(false);
    expect(reg.urls).toEqual([
      'https://registry.npmjs.org/-/npm/v1/attestations/%40svp-labs%2Ftalos@1.2.0',
    ]);
    expect(JSON.parse(await readFile(join(root, MARKER), 'utf8'))).toEqual({
      ...RELEASE,
      integrity: INTEGRITY,
    });

    const again = fakeNpm();
    expect(
      await ensureVerified(RELEASE, { exec: again.exec, fetch: reg.fetch, env, log: quiet }),
    ).toEqual(installed);
    expect(again.calls).toEqual([]);
  });

  it('reinstalls when the cached lockfile no longer matches its marker', async () => {
    const env = await cache();
    const reg = registry(attestationsFor(SHA));
    const first = await ensureVerified(RELEASE, {
      exec: fakeNpm().exec,
      fetch: reg.fetch,
      env,
      log: quiet,
    });
    await writeFile(join(first.root, 'package-lock.json'), lockfile('1.2.0', 'sha512-tampered'));
    const npm = fakeNpm();
    await ensureVerified(RELEASE, { exec: npm.exec, fetch: reg.fetch, env, log: quiet });
    expect(npm.calls).toHaveLength(2);
  });

  it('refuses a package whose provenance names another commit, and caches nothing', async () => {
    const env = await cache();
    const reg = registry(attestationsFor('d'.repeat(40)));
    await expect(
      ensureVerified(RELEASE, { exec: fakeNpm().exec, fetch: reg.fetch, env, log: quiet }),
    ).rejects.toThrow(
      `refusing @svp-labs/talos@1.2.0: it was built from commit ${'d'.repeat(40)}, not ${SHA}`,
    );
    expect(await exists(entryFor(env.TALOS_CACHE ?? '', RELEASE))).toBe(false);
  });

  it('refuses a tarball other than the attested one', async () => {
    const env = await cache();
    const reg = registry(attestationsFor(SHA, Buffer.alloc(64, 9)));
    await expect(
      ensureVerified(RELEASE, { exec: fakeNpm().exec, fetch: reg.fetch, env, log: quiet }),
    ).rejects.toThrow('not the installed tarball');
  });

  it('refuses when signatures fail, when npm fails, or without provenance', async () => {
    const env = await cache();
    const good = registry(attestationsFor(SHA));
    const badAudit = fakeNpm({ audit: '{"invalid":[{"name":"x"}],"missing":[]}' });
    await expect(
      ensureVerified(RELEASE, { exec: badAudit.exec, fetch: good.fetch, env, log: quiet }),
    ).rejects.toThrow('1 invalid signatures');
    await expect(
      ensureVerified(RELEASE, {
        exec: fakeNpm({ installCode: 1 }).exec,
        fetch: good.fetch,
        env,
        log: quiet,
      }),
    ).rejects.toThrow('npm install for @svp-labs/talos exited 1');
    const missing = registry({ error: 'Not found' }, 404);
    await expect(
      ensureVerified(RELEASE, { exec: fakeNpm().exec, fetch: missing.fetch, env, log: quiet }),
    ).rejects.toThrow('has no provenance on the npm registry');
  });

  it('audits once more when only invalid signatures fail, and settles when that is clean', async () => {
    const env = await cache();
    const logged: string[] = [];
    const npm = fakeNpm({ audits: [AUDIT_RACED, '{"invalid":[],"missing":[]}'] });
    const reg = registry(attestationsFor(SHA));
    const installed = await ensureVerified(RELEASE, {
      exec: npm.exec,
      fetch: reg.fetch,
      env,
      log: (line) => logged.push(line),
    });
    expect(installed.integrity).toBe(INTEGRITY);
    expect(npm.calls.filter((call) => call.startsWith('npm audit'))).toHaveLength(2);
    expect(logged).toEqual([
      'npm audit signatures: invalid: @sigstore/core@3.1.0 (EATTESTATIONVERIFY)',
      'npm audit signatures found invalid signatures only: auditing once more',
    ]);
  });

  it('refuses when the second audit finds invalid signatures too, and caches nothing', async () => {
    const env = await cache();
    const logged: string[] = [];
    const npm = fakeNpm({ audits: [AUDIT_RACED, AUDIT_RACED, '{"invalid":[],"missing":[]}'] });
    await expect(
      ensureVerified(RELEASE, {
        exec: npm.exec,
        fetch: registry(attestationsFor(SHA)).fetch,
        env,
        log: (line) => logged.push(line),
      }),
    ).rejects.toThrow('refusing @svp-labs/talos@1.2.0: 1 invalid signatures');
    expect(npm.calls.filter((call) => call.startsWith('npm audit'))).toHaveLength(2);
    expect(logged).toHaveLength(3);
    expect(await exists(entryFor(env.TALOS_CACHE ?? '', RELEASE))).toBe(false);
  });

  it('audits once only when signatures are missing', async () => {
    const env = await cache();
    const logged: string[] = [];
    const npm = fakeNpm({
      audits: [
        '{"invalid":[],"missing":[{"name":"left-pad","version":"1.3.0"}]}',
        '{"invalid":[],"missing":[]}',
      ],
    });
    await expect(
      ensureVerified(RELEASE, {
        exec: npm.exec,
        fetch: registry(attestationsFor(SHA)).fetch,
        env,
        log: (line) => logged.push(line),
      }),
    ).rejects.toThrow('1 missing signatures');
    expect(npm.calls.filter((call) => call.startsWith('npm audit'))).toHaveLength(1);
    expect(logged).toEqual(['npm audit signatures: missing: left-pad@1.3.0']);
  });

  it('refuses when npm installed another version', async () => {
    const env = await cache();
    const npm = fakeNpm();
    const wrong: Exec = async (command, args, options) => {
      const result = await npm.exec(command, args, options);
      if (args[0] === 'install') {
        await writeFile(join(options.cwd, 'package-lock.json'), lockfile('1.1.0', INTEGRITY));
      }
      return result;
    };
    await expect(
      ensureVerified(RELEASE, {
        exec: wrong,
        fetch: registry(attestationsFor(SHA)).fetch,
        env,
        log: quiet,
      }),
    ).rejects.toBeInstanceOf(VersionError);
  });
});

describe('installer helpers', () => {
  it('reads the installed integrity from a lockfile', () => {
    expect(lockedIntegrity(JSON.parse(lockfile('1.2.0', INTEGRITY)), '1.2.0')).toBe(INTEGRITY);
    expect(lockedIntegrity(JSON.parse(lockfile('1.2.0', INTEGRITY)), '1.2.1')).toBeUndefined();
    expect(lockedIntegrity({ packages: {} }, '1.2.0')).toBeUndefined();
    expect(lockedIntegrity('nope', '1.2.0')).toBeUndefined();
  });

  it("reads npm audit signatures' report", () => {
    expect(auditProblems(0, '{"invalid":[],"missing":[]}')).toEqual([]);
    expect(auditProblems(1, '{"invalid":[1,2],"missing":[3]}')).toEqual([
      '2 invalid signatures',
      '1 missing signatures',
    ]);
    expect(auditProblems(1, '{"invalid":[],"missing":[]}')).toEqual([
      'npm audit signatures exited 1',
    ]);
    expect(auditProblems(1, 'npm ERR!')).toEqual([
      'npm audit signatures exited 1 without a readable report',
    ]);
    expect(auditProblems(0, '{}')).toEqual([
      'npm audit signatures exited 0 without a readable report',
    ]);
  });

  it('keeps one cache entry per version and commit', () => {
    expect(entryFor('/c', RELEASE)).toBe(join('/c', 'engine', `1.2.0-${SHA.slice(0, 12)}`));
  });
});

describe('needsLaunch and repoArgument', () => {
  it('launches the commands that act on a repository', () => {
    for (const command of LAUNCHED_COMMANDS) expect(needsLaunch([command], {})).toBe(true);
    for (const command of ['version', 'help', 'self-test', 'doctor', 'status', 'why', 'org']) {
      expect(needsLaunch([command], {})).toBe(false);
    }
    expect(needsLaunch([], {})).toBe(false);
  });

  it('runs as it is once launched, or in development', () => {
    expect(needsLaunch(['check'], { TALOS_LAUNCHED: '1' })).toBe(false);
    expect(needsLaunch(['check'], { TALOS_LAUNCHED: '' })).toBe(true);
    expect(needsLaunch(['check'], { TALOS_DEV: '1' })).toBe(false);
    expect(needsLaunch(['check'], { TALOS_DEV: '0' })).toBe(true);
  });

  it('takes the repository a command names', () => {
    expect(repoArgument(['ticket', 'claim', '41', '--repo', 'SVP-Labs/Thea'])).toBe(
      'SVP-Labs/Thea',
    );
    expect(repoArgument(['ticket', '--repo=SVP-Labs/Thea'])).toBe('SVP-Labs/Thea');
    expect(repoArgument(['ticket', '--repo'])).toBeUndefined();
    expect(repoArgument(['ticket', '--repo', 'nope'])).toBeUndefined();
    expect(repoArgument(['check'])).toBeUndefined();
  });

  it('knows the verified install of a release', () => {
    expect(isVerifiedInstall({ ...RELEASE, integrity: INTEGRITY }, '1.2.0', RELEASE)).toBe(true);
    expect(isVerifiedInstall({ ...RELEASE }, '1.2.1', RELEASE)).toBe(false);
    expect(isVerifiedInstall({ version: '1.2.0', sha: 'd'.repeat(40) }, '1.2.0', RELEASE)).toBe(
      false,
    );
    expect(isVerifiedInstall({ version: '1.1.0', sha: SHA }, '1.2.0', RELEASE)).toBe(false);
    expect(isVerifiedInstall(undefined, '1.2.0', RELEASE)).toBe(false);
  });
});

type Recorded = {
  bin: string;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
};

function deps(overrides: Partial<LaunchDeps> = {}): {
  deps: LaunchDeps;
  runs: Recorded[];
  errors: string[];
} {
  const runs: Recorded[] = [];
  const errors: string[] = [];
  const installed: Installed = { ...RELEASE, integrity: INTEGRITY, root: '/c', bin: '/c/bin.js' };
  return {
    runs,
    errors,
    deps: {
      env: { PATH: '/bin' },
      err: (text) => errors.push(text),
      resolve: () => Promise.resolve(RELEASE),
      isRunning: () => Promise.resolve(false),
      install: () => Promise.resolve(installed),
      run: (bin, argv, env) => {
        runs.push({ bin, argv, env });
        return Promise.resolve(7);
      },
      ...overrides,
    },
  };
}

describe('launchWith', () => {
  it('runs the verified enforced release with the same arguments and passes its code on', async () => {
    const { deps: d, runs } = deps();
    expect(await launchWith(['check', '--json'], d)).toBe(7);
    expect(runs).toEqual([
      {
        bin: '/c/bin.js',
        argv: ['check', '--json'],
        env: { PATH: '/bin', TALOS_LAUNCHED: '1', TALOS_VERSION: '1.2.0', TALOS_SHA: SHA },
      },
    ]);
  });

  it('goes on in this process when it is already the verified release', async () => {
    const { deps: d, runs } = deps({ isRunning: () => Promise.resolve(true) });
    expect(await launchWith(['check'], d)).toBeUndefined();
    expect(runs).toEqual([]);
  });

  it('does nothing for commands that need no repository', async () => {
    const { deps: d } = deps({ resolve: () => Promise.reject(new Error('no lookup expected')) });
    expect(await launchWith(['version'], d)).toBeUndefined();
    expect(await launchWith(['check'], { ...d, env: { TALOS_DEV: '1' } })).toBeUndefined();
  });

  it('explains a failure and exits 2', async () => {
    const { deps: d, errors } = deps({
      resolve: () => Promise.reject(new VersionError('no GitHub repository here')),
    });
    expect(await launchWith(['check'], d)).toBe(2);
    expect(errors).toEqual(['talos: no GitHub repository here\n']);
    const refused = deps({ install: () => Promise.reject(new VersionError('refusing it')) });
    expect(await launchWith(['run'], refused.deps)).toBe(2);
    expect(refused.errors).toEqual(['talos: refusing it\n']);
    const odd = deps({
      install: () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await launchWith(['run'], odd.deps)).toBe(2);
    expect(odd.errors).toEqual(['talos: fetch failed\n']);
  });
});

describe('runNode', () => {
  it('runs an entry point with the same Node and passes its exit code on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talos-run-test-'));
    const bin = join(root, 'talos.js');
    await writeFile(bin, 'process.exit(Number(process.argv[2]) + Number(process.env.EXTRA));\n');
    expect(await runNode(bin, ['3'], { ...process.env, EXTRA: '4' })).toBe(7);
  });
});

describe('launch', () => {
  it('leaves commands that need no repository to this process', async () => {
    expect(await launch(['version'])).toBeUndefined();
  });
});

describe('self', () => {
  it("reads this package's version and Node range", () => {
    expect(ownVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(requiredNode()).toMatch(/^>=\d+/);
  });

  it('names its build by a digest that stays put while the code does', async () => {
    const build = await ownBuild();
    expect(build).toMatch(/^[0-9a-f]{12}$/);
    expect(await ownBuild()).toBe(build);
  });

  it('has no verification marker outside the cache', async () => {
    expect(await ownInstallMarker()).toBeUndefined();
  });
});
