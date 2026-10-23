import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { dependabotYml, ecosystems, fixturePaths, parseDefaults } from './dependabot.js';
import { assetsDir } from '../version/self.js';

const DEFAULTS = parseDefaults('schedule: { interval: weekly }\ncooldown: { default-days: 1 }\n');

describe('ecosystems', () => {
  it('lists every ecosystem present with its directories', () => {
    const found = ecosystems(
      [
        { lang: 'ts', root: '.', os: ['linux'] },
        { lang: 'ts', root: 'web', os: ['linux'] },
        { lang: 'py', root: 'api', os: ['linux'] },
        { lang: 'py', root: 'tools', os: ['linux'] },
        { lang: 'php', root: 'site', os: ['linux'] },
        { lang: 'lua', root: 'mods', os: ['linux'] },
        { lang: 'rust', root: 'apps/desktop', os: ['linux'] },
      ],
      ['api/uv.lock', 'Dockerfile', 'api/Dockerfile.dev', 'web/x.Dockerfile'],
    );
    expect(found).toEqual([
      { ecosystem: 'npm', directories: ['/', '/web'] },
      { ecosystem: 'uv', directories: ['/api'] },
      { ecosystem: 'pip', directories: ['/tools'] },
      { ecosystem: 'composer', directories: ['/site'] },
      { ecosystem: 'cargo', directories: ['/apps/desktop'] },
      { ecosystem: 'docker', directories: ['/', '/api'] },
      { ecosystem: 'github-actions', directories: ['/'] },
    ]);
  });
});

function fresh(): string {
  return (
    dependabotYml(
      undefined,
      [
        { ecosystem: 'npm', directories: ['/'] },
        { ecosystem: 'github-actions', directories: ['/'] },
      ],
      DEFAULTS,
    ) ?? ''
  );
}

describe('dependabotYml', () => {
  const present = [
    { ecosystem: 'npm', directories: ['/'] },
    { ecosystem: 'github-actions', directories: ['/'] },
  ];

  it('writes a file with a one-day cooldown for every ecosystem, without anchors', () => {
    expect(fresh()).not.toContain('&');
    expect(parse(dependabotYml(undefined, present, DEFAULTS) ?? '')).toEqual({
      version: 2,
      updates: [
        {
          'package-ecosystem': 'npm',
          directories: ['/'],
          schedule: { interval: 'weekly' },
          cooldown: { 'default-days': 1 },
        },
        {
          'package-ecosystem': 'github-actions',
          directories: ['/'],
          schedule: { interval: 'weekly' },
          cooldown: { 'default-days': 1 },
        },
      ],
    });
  });

  it('keeps existing entries and comments, adding the cooldown and missing ecosystems', () => {
    const existing =
      '# ours\nversion: 2\nupdates:\n  - package-ecosystem: npm # main app\n    directory: /\n    schedule:\n      interval: daily\n  - package-ecosystem: bundler\n    directory: /\n    schedule: { interval: daily }\n    cooldown:\n      default-days: 3\n';
    const out = dependabotYml(existing, present, DEFAULTS) ?? '';
    expect(out).toContain('# ours');
    expect(out).toContain('# main app');
    const parsed = parse(out) as { updates: Record<string, unknown>[] };
    expect(parsed.updates.map((u) => u['package-ecosystem'])).toEqual([
      'npm',
      'bundler',
      'github-actions',
    ]);
    expect(parsed.updates.map((u) => u.cooldown)).toEqual([
      { 'default-days': 1 },
      { 'default-days': 3 },
      { 'default-days': 1 },
    ]);
    expect(dependabotYml(out, present, DEFAULTS)).toBeUndefined();
  });

  it('adds a cooldown to an entry without one, and leaves one it cannot read alone', () => {
    const existing =
      'version: 2\nupdates:\n  - package-ecosystem: npm\n    schedule: { interval: daily }\n' +
      '  - package-ecosystem: github-actions\n    cooldown: { semver-major-days: 7 }\n' +
      '  - package-ecosystem: pip\n    cooldown: 3\n  - just text\n';
    const parsed = parse(dependabotYml(existing, present, DEFAULTS) ?? '') as {
      updates: Record<string, unknown>[];
    };
    expect(parsed.updates.map((u) => (typeof u === 'object' ? u.cooldown : u))).toEqual([
      { 'default-days': 1 },
      { 'semver-major-days': 7, 'default-days': 1 },
      3,
      'just text',
    ]);
    expect(dependabotYml(fresh(), present, DEFAULTS)).toBeUndefined();
  });

  it('replaces a file without an updates list', () => {
    expect(parse(dependabotYml('version: 2\n', present, DEFAULTS) ?? '')).toMatchObject({
      version: 2,
    });
  });
});

describe('holding and fixtures', () => {
  const present = [{ ecosystem: 'npm', directories: ['/'] }];

  it('holds every day count at least a day, and exempts no dependency', () => {
    const existing =
      'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n' +
      '    cooldown:\n      default-days: 0\n      semver-major-days: 0\n' +
      '      semver-minor-days: 3\n      exclude: ["react"]\n';
    const out = dependabotYml(existing, present, DEFAULTS) ?? '';
    expect(parse(out)).toMatchObject({
      updates: [
        {
          cooldown: { 'default-days': 1, 'semver-major-days': 1, 'semver-minor-days': 3 },
        },
      ],
    });
    expect(out).not.toContain('exclude');
    expect(dependabotYml(out, present, DEFAULTS)).toBeUndefined();
  });

  it('leaves the test fixtures out of every entry, new or existing', () => {
    const made = dependabotYml(undefined, present, DEFAULTS, ['test-projects/**']) ?? '';
    expect(parse(made)).toMatchObject({ updates: [{ 'exclude-paths': ['test-projects/**'] }] });
    const existing =
      'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n' +
      '    cooldown: { default-days: 1 }\n    exclude-paths: [docs/**]\n' +
      '  - package-ecosystem: pip\n    cooldown: { default-days: 1 }\n    exclude-paths: x\n';
    const out = dependabotYml(existing, present, DEFAULTS, ['test-projects/**', 'docs/**']) ?? '';
    expect(parse(out)).toMatchObject({
      updates: [{ 'exclude-paths': ['docs/**', 'test-projects/**'] }, { 'exclude-paths': 'x' }],
    });
    expect(dependabotYml(out, present, DEFAULTS, ['test-projects/**'])).toBeUndefined();
  });

  it('finds the fixture folders that hold manifests', () => {
    expect(
      fixturePaths([
        'test-projects/ts/clean/package.json',
        'test-projects/py/clean/uv.lock',
        'src/version/fixtures/pkg/package.json',
        'src/fixtures/readme.md',
        'tests/testdata/Dockerfile.dev',
        'tests/testdata/x/requirements-dev.txt',
        'lua/__fixtures__/a.rockspec',
        'package.json',
      ]),
    ).toEqual([
      'lua/__fixtures__/**',
      'src/version/fixtures/**',
      'test-projects/**',
      'tests/testdata/**',
    ]);
  });
});

describe('the shipped defaults', () => {
  it('hold every update a day', async () => {
    const text = await readFile(new URL('dependabot/update.yml', assetsDir()), 'utf8');
    expect(parseDefaults(text).cooldown['default-days']).toBe(1);
  });
});
