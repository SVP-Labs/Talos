import { describe, expect, it } from 'vitest';
import { parseMetadata } from './metadata.js';
import { mutantsArgs } from './mutants.js';
import { buildFailure, nextestArgs, nextestConfig, selection } from './nextest.js';

const ws = parseMetadata(
  JSON.stringify({
    workspace_root: '/ws',
    packages: [
      {
        name: 'demo',
        manifest_path: '/ws/Cargo.toml',
        targets: [
          { kind: ['lib'], name: 'demo', src_path: '/ws/src/lib.rs', doctest: true },
          { kind: ['test'], name: 'slow', src_path: '/ws/tests/slow.rs', doctest: false },
        ],
      },
    ],
  }),
  '/ws',
);

describe('selection', () => {
  it('runs everything, everything but tests.full, or a rerun’s files', () => {
    expect(
      selection(ws, { suite: 'all', coverage: true }, { full: ['tests/slow.rs'] }),
    ).toBeUndefined();
    expect(selection(ws, { suite: 'commit', coverage: false }, { full: ['tests/slow.rs'] })).toBe(
      'not (binary_id(=demo::slow))',
    );
    expect(selection(ws, { suite: 'commit', coverage: false }, { full: [] })).toBeUndefined();
    expect(
      selection(
        ws,
        { suite: 'commit', coverage: false, files: [] },
        { full: [], files: ['src/a.rs'] },
      ),
    ).toBe('(binary_id(=demo) & test(/^a::/))');
    expect(
      selection(
        ws,
        { suite: 'commit', coverage: false, files: [] },
        { full: [], files: ['README.md'] },
      ),
    ).toBeNull();
  });
});

describe('nextest', () => {
  it('runs without retries, fail-fast or the project’s default filter', () => {
    const args = nextestArgs('/scratch/n.toml', 'not (binary_id(=demo::slow))');
    expect(args).toEqual(
      expect.arrayContaining([
        '--no-fail-fast',
        '--ignore-default-filter',
        '--locked',
        '--all-features',
      ]),
    );
    expect(args.slice(args.indexOf('--retries'), args.indexOf('--retries') + 2)).toEqual([
      '--retries',
      '0',
    ]);
    expect(args.slice(-4)).toEqual(['--profile', 'talos', '-E', 'not (binary_id(=demo::slow))']);
    expect(nextestArgs('/scratch/n.toml', undefined)).not.toContain('-E');
  });

  it('writes its JUnit into the scratch store, with forward slashes', () => {
    expect(nextestConfig(String.raw`C:\scratch\store`)).toContain('dir = "C:/scratch/store"');
    expect(nextestConfig('/s')).toContain('[profile.talos.junit]\npath = "junit.xml"');
  });

  it('stands a build that failed for one failing case', () => {
    const xml = buildFailure({
      code: 101,
      stdout: '',
      stderr: 'Compiling x\nerror[E0308]: mismatched types\n',
    });
    expect(xml).toContain('<failure message="error[E0308]: mismatched types"/>');
    expect(xml).toContain('file="Cargo.toml"');
  });
});

describe('mutantsArgs', () => {
  it('mutates only the given files, against the whole workspace’s tests', () => {
    const args = mutantsArgs(['src/a.rs', 'src/b.rs'], '/out');
    expect(args).toContain('--no-config');
    expect(args.slice(-4)).toEqual(['--file', 'src/a.rs', '--file', 'src/b.rs']);
    expect(
      args.slice(args.indexOf('--test-workspace'), args.indexOf('--test-workspace') + 2),
    ).toEqual(['--test-workspace', 'true']);
    expect(args).toContain('--cargo-test-arg=--retries=0');
  });
});
