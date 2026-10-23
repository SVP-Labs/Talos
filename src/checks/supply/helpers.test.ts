import { describe, expect, it } from 'vitest';
import { fixedVersions, sameName, type Vulnerability } from './advisories.js';
import { baseText } from './base.js';
import { beyond, expired, hoursBetween, isoDay } from './dates.js';
import { dependabotGaps, holdsADay } from './dependabot.js';
import { entryLine, judgeEntry } from './expired.js';
import { getJson, inPool } from './fetcher.js';
import { judge, replacedVersions } from './judged.js';
import { parseLockfile } from './lockfiles/index.js';
import { pnpmSettings, PNPM_GUARDS } from './pnpm-settings.js';
import { earlierTrust } from './provenance.js';
import { crateIndexPath } from './registries.js';
import { durationHours, uvHoldsADay } from './settings.js';
import { EngineError } from '../../core/check.js';
import { parseDiff } from '../../repo/changes.js';

const BASE = ['lockfileVersion: 9.0', 'packages:', '  a@1.0.0: {}', '  b@1.0.0: {}', ''].join('\n');
const HEAD = [
  'lockfileVersion: 9.0',
  'packages:',
  '  a@1.0.1: {}',
  '  b@1.0.0: {}',
  '  c@2.0.0: {}',
  '',
].join('\n');

// `git diff -U0` between BASE and HEAD as pnpm-lock.yaml.
const DIFF = [
  'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
  'index 1111111..2222222 100644',
  '--- a/pnpm-lock.yaml',
  '+++ b/pnpm-lock.yaml',
  '@@ -3 +3 @@ packages:',
  '-  a@1.0.0: {}',
  '+  a@1.0.1: {}',
  '@@ -4,0 +5 @@ packages:',
  '+  c@2.0.0: {}',
].join('\n');

describe('baseText', () => {
  const change = parseDiff(DIFF).files.get('pnpm-lock.yaml');

  it('rebuilds the base file from head and a zero-context diff', () => {
    expect(change).toBeDefined();
    if (change === undefined) return;
    expect(baseText(HEAD, change)).toEqual({ known: true, text: BASE });
  });

  it('knows an added file had nothing at base', () => {
    const added = parseDiff(
      'diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+one',
    ).files.get('x');
    expect(added && baseText('one\n', added)).toEqual({ known: true, text: undefined });
  });

  it('distrusts a modified file without hunks or with texts that miss lines', () => {
    const bare = parseDiff('diff --git a/x b/x\nindex 1..2 100644').files.get('x');
    expect(bare && baseText('one', bare)).toEqual({ known: false });
    const short = parseDiff(
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b',
    ).files.get('x');
    expect(short && baseText('b\nc', short)).toEqual({ known: false });
  });
});

describe('judge', () => {
  const changes = parseDiff(DIFF);

  it('judges every version alone, and on head only the ones the change added', () => {
    const names = (side: 'alone' | 'head' | 'base'): string[] =>
      judge({ side, changes }, 'pnpm-lock.yaml', side === 'base' ? BASE : HEAD).judged.map(
        (l) => `${l.name}@${l.version}`,
      );
    expect(names('alone')).toEqual(['a@1.0.1', 'b@1.0.0', 'c@2.0.0']);
    expect(names('head')).toEqual(['a@1.0.1', 'c@2.0.0']);
    expect(names('base')).toEqual([]);
    const head = judge({ side: 'head', changes }, 'pnpm-lock.yaml', HEAD);
    expect(head.replaced.get('a')).toEqual(['1.0.0']);
  });

  it('judges nothing in a lockfile the change left alone', () => {
    expect(judge({ side: 'head', changes }, 'other/pnpm-lock.yaml', HEAD).judged).toEqual([]);
  });

  it('pairs replaced versions by package name', () => {
    const head = parseLockfile('pnpm-lock.yaml', HEAD);
    const base = parseLockfile('pnpm-lock.yaml', BASE);
    expect([...replacedVersions(head, base)]).toEqual([['a', ['1.0.0']]]);
  });
});

describe('dates', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  const entry = (expires: string) => ({ reason: 'r', expires });

  it('expires an entry on its date', () => {
    expect(isoDay(now)).toBe('2026-10-23');
    expect(expired(entry('2026-10-23'), now)).toBe(true);
    expect(expired(entry('2026-10-24'), now)).toBe(false);
    expect(beyond(entry('2026-10-30'), now, 7)).toBe(false);
    expect(beyond(entry('2026-10-31'), now, 7)).toBe(true);
    expect(hoursBetween(new Date('2026-10-23T09:30:00Z'), now)).toBe(2);
  });

  it('judges talos.yml entries and finds their lines', () => {
    const allow = { list: 'allow' as const, name: 'a@1.0.0', entry: entry('2026-10-20') };
    expect(judgeEntry(allow, now)).toMatchObject({ rule: 'supply/expired', policy: 'always' });
    const long = { ...allow, entry: entry('2026-12-01') };
    expect(judgeEntry(long, now)).toMatchObject({ rule: 'supply/allow-too-long' });
    const exception = { list: 'exceptions' as const, name: 'GHSA-x', entry: entry('2026-12-01') };
    expect(judgeEntry(exception, now)).toBeUndefined();
    const text = 'supply_chain:\n  allow:\n    "a@1.0.0": { reason: r, expires: 2026-10-20 }\n';
    expect(entryLine(text, 'a@1.0.0')).toBe(3);
    expect(entryLine('exceptions:\n  GHSA-x: {}\n', 'GHSA-x')).toBe(2);
    expect(entryLine('', 'none')).toBeUndefined();
  });
});

describe('advisories', () => {
  const advisory: Vulnerability = {
    id: 'GHSA-35jh-r3h4-6jhm',
    affected: [
      {
        package: { name: 'lodash', ecosystem: 'npm' },
        ranges: [{ events: [{ fixed: undefined }, { fixed: '4.17.21' }] }],
      },
      { package: { name: 'lodash-es', ecosystem: 'npm' }, ranges: [{ events: [{ fixed: '9' }] }] },
    ],
  };

  it('reads the fixed versions for one package', () => {
    expect(fixedVersions(advisory, 'npm', 'lodash')).toEqual(['4.17.21']);
    expect(fixedVersions(advisory, 'pypi', 'lodash')).toEqual([]);
  });

  it('compares PyPI names the way PyPI does', () => {
    expect(sameName('pypi', 'Foo_Bar', 'foo-bar')).toBe(true);
    expect(sameName('npm', 'Foo', 'foo')).toBe(false);
  });
});

describe('registries and fetching', () => {
  it('finds a crate in the sparse index', () => {
    expect(crateIndexPath('a')).toBe('1/a');
    expect(crateIndexPath('ab')).toBe('2/ab');
    expect(crateIndexPath('Syn')).toBe('3/s/syn');
    expect(crateIndexPath('itoa')).toBe('it/oa/itoa');
  });

  it('reads JSON, a 404 as nothing, and anything else as an engine error', async () => {
    const answer = (status: number, body: string) => () => Promise.resolve({ status, body });
    expect(await getJson(answer(200, '{"a":1}'), { url: 'u' }, 'x')).toEqual({ a: 1 });
    expect(await getJson(answer(404, ''), { url: 'u' }, 'x')).toBeUndefined();
    await expect(getJson(answer(500, ''), { url: 'u' }, 'x')).rejects.toThrow(EngineError);
    await expect(getJson(answer(200, '<html>'), { url: 'u' }, 'x')).rejects.toThrow(/JSON/);
    const down = () => Promise.reject(new Error('ECONNRESET'));
    await expect(getJson(down, { url: 'u' }, 'x')).rejects.toThrow(/could not be reached/);
  });

  it('keeps the order of pooled work', async () => {
    const delays = [30, 0, 10];
    const out = await inPool(delays, 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(out).toEqual(delays);
  });

  it('compares a release with the most trust the earlier ones had', () => {
    const at = (iso: string) => new Date(iso);
    const found = {
      published: new Map([
        ['7.5.3', at('2023-06-22T21:53:19Z')],
        ['6.3.1', at('2023-07-10T22:38:41Z')],
        ['7.7.3', at('2025-10-07T18:00:51Z')],
      ]),
      trust: new Map<string, 0 | 1 | 2>([
        ['7.5.3', 1],
        ['6.3.1', 0],
        ['7.7.3', 2],
      ]),
    };
    expect(earlierTrust(found, '6.3.1')).toBe(1);
    expect(earlierTrust(found, '7.5.3')).toBe(0);
    expect(earlierTrust(found, 'missing')).toBe(0);
  });
});

describe('settings', () => {
  it('reads pnpm settings from pnpm-workspace.yaml over .npmrc', () => {
    const settings = pnpmSettings(
      'minimumReleaseAge: 1440\ntrustPolicy: no-downgrade\n',
      'block-exotic-subdeps=true\ntrust-policy=off\n; a comment\n',
    );
    expect(settings).toEqual({
      minimumReleaseAge: 1440,
      blockExoticSubdeps: true,
      trustPolicy: 'no-downgrade',
    });
    expect(PNPM_GUARDS.every((guard) => guard.holds(settings))).toBe(true);
    expect(PNPM_GUARDS.filter((guard) => !guard.holds({})).map((g) => g.setting)).toEqual([
      'minimumReleaseAge',
      'blockExoticSubdeps',
      'trustPolicy',
    ]);
    expect(pnpmSettings('{ not yaml', undefined)).toEqual({});
  });

  it('reads ISO 8601 durations', () => {
    expect(durationHours('P1D')).toBe(24);
    expect(durationHours('PT36H')).toBe(36);
    expect(durationHours('P1W')).toBe(168);
    expect(durationHours('PT1H30M')).toBe(1.5);
    expect(durationHours('P')).toBeUndefined();
    expect(durationHours('1 day')).toBeUndefined();
    expect(durationHours('P1X')).toBeUndefined();
    expect(durationHours('PT1')).toBeUndefined();
    expect(uvHoldsADay('[options]\nexclude-newer-span = "P1D"\n')).toBe(true);
    expect(uvHoldsADay('[options]\nexclude-newer-span = "PT12H"\n')).toBe(false);
    expect(uvHoldsADay('version = 1\n')).toBe(false);
    expect(uvHoldsADay('= broken')).toBe(false);
  });

  it('holds Dependabot to a day for every ecosystem and directory', () => {
    expect(holdsADay({ 'default-days': 1 })).toBe(true);
    expect(holdsADay({ 'default-days': 1, 'semver-patch-days': 0 })).toBe(false);
    expect(holdsADay({ 'default-days': 2, exclude: ['*'] })).toBe(false);
    expect(holdsADay(undefined)).toBe(false);
    const wanted = [
      { ecosystem: 'npm', directories: ['/', '/apps/web'] },
      { ecosystem: 'github-actions', directories: ['/'] },
    ];
    const yml = [
      'version: 2',
      'updates:',
      '  - package-ecosystem: npm',
      '    directories: ["/", "/apps/*"]',
      '    cooldown: { default-days: 1 }',
      '  - package-ecosystem: github-actions',
      '    directory: /',
      '    cooldown: { default-days: 0 }',
    ].join('\n');
    expect(dependabotGaps(yml, wanted).map((gap) => gap.key)).toEqual([
      'dependabot cooldown github-actions /',
    ]);
    expect(dependabotGaps(undefined, wanted)[0]?.message).toMatch(/npm, github-actions/);
    expect(dependabotGaps('updates: 3', wanted)[0]?.message).toMatch(/cannot be read/);
    expect(dependabotGaps('version: 2\n', wanted).map((gap) => gap.key)).toEqual([
      'dependabot npm /',
      'dependabot npm /apps/web',
      'dependabot github-actions /',
    ]);
  });
});
