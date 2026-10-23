import { describe, expect, it } from 'vitest';
import type { Fetcher, HttpRequest } from './fetcher.js';
import { supplyChecks } from './index.js';
import { parseConfig } from '../../config/load.js';
import type { Pack } from '../../core/pack.js';
import type { RunResult } from '../../core/result.js';
import type { RunPlan } from '../../engine/run.js';
import { runChecks } from '../../engine/run.js';
import { parseDiff } from '../../repo/changes.js';
import { MINIMAL_CONFIG, tempRepo, testEngine, testPlan } from '../../testing/engine.js';

const NOW = new Date('2026-10-23T12:00:00Z');
const HOURS_AGO = (hours: number): string =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();

// Trimmed from the live registries (npm's semver document, OSV's lodash advisory) and made up
// where a release had to be young.
const ROUTES: Readonly<Record<string, unknown>> = {
  'https://registry.npmjs.org/left-pad': { time: { '1.3.0': '2018-04-09T01:10:45.796Z' } },
  'https://registry.npmjs.org/young': { time: { '2.0.0': HOURS_AGO(3) } },
  'https://registry.npmjs.org/lodash': { time: { '4.17.21': HOURS_AGO(2) } },
  'https://registry.npmjs.org/semver': {
    time: {
      '7.5.3': '2023-06-22T21:53:19.774Z',
      '6.3.1': '2023-07-10T22:38:41.428Z',
      '7.7.3': '2025-10-07T18:00:51.643Z',
    },
    versions: {
      '7.5.3': {
        dist: {
          attestations: {
            url: 'https://registry.npmjs.org/-/npm/v1/attestations/semver@7.5.3',
            provenance: { predicateType: 'https://slsa.dev/provenance/v0.2' },
          },
        },
      },
      '6.3.1': { dist: {} },
      '7.7.3': {
        dist: { attestations: { provenance: {} } },
        _npmUser: { name: 'GitHub Actions', trustedPublisher: { id: 'github' } },
      },
    },
  },
  'https://pypi.org/pypi/six/1.17.0/json': {
    urls: [{ upload_time_iso_8601: HOURS_AGO(5) }, { upload_time_iso_8601: HOURS_AGO(4) }],
  },
  'https://repo.packagist.org/p2/psr/log.json': {
    minified: 'composer/2.0',
    packages: { 'psr/log': [{ version: '3.0.2', time: HOURS_AGO(1) }, { version: '3.0.1' }] },
  },
  'https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm': {
    id: 'GHSA-35jh-r3h4-6jhm',
    affected: [
      {
        package: { name: 'lodash', ecosystem: 'npm' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
      },
    ],
  },
};

const CRATES = [
  JSON.stringify({ name: 'either', vers: '1.0.11', pubtime: HOURS_AGO(6) }),
  JSON.stringify({ name: 'either', vers: '1.0.10' }),
].join('\n');

function osvBatch(request: HttpRequest): unknown {
  const asked = JSON.stringify(request.body ?? '');
  const vulns = asked.includes('4.17.20') ? [{ id: 'GHSA-35jh-r3h4-6jhm' }] : [];
  return { results: [{ vulns }] };
}

const fetcher: Fetcher = (request) => {
  if (request.url === 'https://api.osv.dev/v1/querybatch') {
    return Promise.resolve({ status: 200, body: JSON.stringify(osvBatch(request)) });
  }
  if (request.url === 'https://index.crates.io/ei/th/either') {
    return Promise.resolve({ status: 200, body: CRATES });
  }
  const body = ROUTES[request.url];
  return Promise.resolve(
    body === undefined ? { status: 404, body: '' } : { status: 200, body: JSON.stringify(body) },
  );
};

const pack: Pack = { name: 'supply', checks: supplyChecks({ fetcher, now: () => NOW }) };

const npmLock = (packages: Record<string, string>): string =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      ...Object.fromEntries(
        Object.entries(packages).map(([name, version]) => [
          `node_modules/${name}`,
          { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` },
        ]),
      ),
    },
  });

async function run(
  files: Record<string, string>,
  only: string[],
  extra: Partial<RunPlan> = {},
): Promise<RunResult> {
  const root = await tempRepo(files);
  const config = parseConfig(files['talos.yml'] ?? MINIMAL_CONFIG);
  const plan = { ...testPlan(root, Object.keys(files), config), only, ...extra };
  return runChecks(testEngine([pack]), plan);
}

const rules = (result: RunResult): string[] =>
  result.outcomes.flatMap((o) => o.findings.map((f) => `${f.rule} ${f.key ?? ''}`));

const errors = (result: RunResult): string[] =>
  result.outcomes.flatMap((o) => (o.status === 'error' ? [o.reason ?? ''] : []));

describe('supply/release-age', () => {
  it('finds a young release in every ecosystem, and honours supply_chain.allow', async () => {
    const result = await run(
      {
        'package-lock.json': npmLock({ 'left-pad': '1.3.0', young: '2.0.0' }),
        'py/uv.lock':
          '[[package]]\nname = "six"\nversion = "1.17.0"\nsource = { registry = "https://pypi.org/simple" }\n',
        'php/composer.lock': JSON.stringify({
          packages: [
            {
              name: 'psr/log',
              version: '3.0.2',
              'notification-url': 'https://packagist.org/downloads/',
            },
          ],
        }),
        'rs/Cargo.lock':
          '[[package]]\nname = "either"\nversion = "1.0.11"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
        'talos.yml': `${MINIMAL_CONFIG}supply_chain:\n  allow:\n    "six@1.17.0": { reason: needed, expires: 2026-10-25 }\n`,
      },
      ['supply/release-age'],
    );
    expect(errors(result)).toEqual([]);
    expect(rules(result).sort((a, b) => a.localeCompare(b))).toEqual([
      'supply/young-release either@1.0.11',
      'supply/young-release psr/log@3.0.2',
      'supply/young-release young@2.0.0',
    ]);
    const message = result.outcomes[0]?.findings.find((f) => f.key === 'young@2.0.0')?.message;
    expect(message).toMatch(/^young@2.0.0 in package-lock.json was published 3 hours ago/);
  });

  it('lets a young fix through when it fixes an advisory against the version it replaces', async () => {
    const head = npmLock({ lodash: '4.17.21', young: '2.0.0' });
    const base = npmLock({ lodash: '4.17.20' });
    const diff = unifiedDiff('package-lock.json', base, head);
    const result = await run({ 'package-lock.json': head }, ['supply/release-age'], {
      side: 'head',
      changes: parseDiff(diff),
    });
    expect(errors(result)).toEqual([]);
    expect(rules(result)).toEqual(['supply/young-release young@2.0.0']);
    const atBase = await run({ 'package-lock.json': base }, ['supply/release-age'], {
      side: 'base',
      changes: parseDiff(diff),
    });
    expect(rules(atBase)).toEqual([]);
  });
});

describe('supply/provenance', () => {
  it('finds a release with less provenance than the ones before it', async () => {
    const result = await run({ 'package-lock.json': npmLock({ semver: '6.3.1' }) }, [
      'supply/provenance',
    ]);
    expect(rules(result)).toEqual(['supply/provenance-downgrade semver@6.3.1']);
    expect(result.outcomes[0]?.findings[0]?.message).toMatch(/neither provenance.*attestation/);
  });

  it('leaves pnpm to refuse it when its trust policy is on', async () => {
    const lock =
      "lockfileVersion: '9.0'\npackages:\n  semver@6.3.1:\n    resolution: {integrity: x}\n";
    const result = await run(
      { 'pnpm-lock.yaml': lock, 'pnpm-workspace.yaml': 'trustPolicy: no-downgrade\n' },
      ['supply/provenance'],
    );
    expect(result.outcomes[0]?.status).toBe('passed');
  });
});

describe('supply/exotic', () => {
  it('finds git and URL dependencies', async () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/g': {
          version: '1.0.0',
          resolved: 'git+https://user:pw@example.com/g.git#abc',
        },
        'node_modules/t': { version: '1.0.0', resolved: 'https://example.com/t.tgz' },
      },
    });
    const result = await run({ 'package-lock.json': lock }, ['supply/exotic']);
    expect(rules(result)).toEqual([
      'supply/exotic-source g git+https://example.com/g.git#abc',
      'supply/exotic-source t https://example.com/t.tgz',
    ]);
  });
});

describe('supply/settings', () => {
  it('wants pnpm, uv and Dependabot to carry the rules', async () => {
    const result = await run(
      {
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
        'pnpm-workspace.yaml': 'minimumReleaseAge: 60\nblockExoticSubdeps: true\n',
        'py/uv.lock': 'version = 1\n',
        '.github/dependabot.yml':
          'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    cooldown: { default-days: 1 }\n',
        'talos.yml': `${MINIMAL_CONFIG}components:\n  - { lang: ts }\n  - { lang: py, root: py }\n`,
      },
      ['supply/settings'],
    );
    expect(rules(result).sort((a, b) => a.localeCompare(b))).toEqual([
      'supply/setting dependabot github-actions /',
      'supply/setting dependabot uv /py',
      'supply/setting pnpm . minimumReleaseAge',
      'supply/setting pnpm . trustPolicy',
      'supply/setting uv py exclude-newer',
    ]);
    const pnpm = result.outcomes[0]?.findings.find((f) => f.key === 'pnpm . trustPolicy');
    expect(pnpm?.location).toEqual({ file: 'pnpm-workspace.yaml', line: 1, endLine: 2 });
  });
});

describe('supply/expired', () => {
  it('fails expired entries always, and allow entries reaching past a week', async () => {
    const result = await run(
      {
        'talos.yml': [
          MINIMAL_CONFIG.trimEnd(),
          'supply_chain:',
          '  allow:',
          '    "a@1.0.0": { reason: r, expires: 2026-11-30 }',
          '  exceptions:',
          '    GHSA-aaaa-bbbb-cccc: { reason: r, expires: 2026-10-01 }',
          '',
        ].join('\n'),
      },
      ['supply/expired'],
    );
    const findings = result.outcomes[0]?.findings ?? [];
    expect(findings.map((f) => [f.rule, f.policy, f.location?.line])).toEqual([
      ['supply/allow-too-long', 'standard', 5],
      ['supply/expired', 'always', 7],
    ]);
  });
});

/** A `git diff -U0` of one whole-line change set: every differing line replaced in one hunk. */
function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n');
}
