import { describe, expect, it } from 'vitest';
import { doctestFilters } from './cargo-test.js';
import { binaryId, parseMetadata, type Workspace } from './metadata.js';
import { filterFor, modulePath, testFile } from './testfiles.js';

/** Recorded from `cargo metadata --format-version 1 --no-deps`, trimmed to what is read. */
const METADATA = JSON.stringify({
  packages: [
    {
      name: 'demo-core',
      manifest_path: '/ws/core/Cargo.toml',
      targets: [
        { kind: ['lib'], name: 'demo_core', src_path: '/ws/core/src/lib.rs', doctest: true },
        { kind: ['test'], name: 'api', src_path: '/ws/core/tests/api.rs', doctest: false },
      ],
    },
    {
      name: 'demo-app',
      manifest_path: '/ws/app/Cargo.toml',
      targets: [
        { kind: ['bin'], name: 'demo-app', src_path: '/ws/app/src/main.rs', doctest: false },
      ],
    },
  ],
  workspace_members: [],
  workspace_root: '/ws',
  target_directory: '/ws/target',
});

const ws: Workspace = parseMetadata(METADATA, '/ws');

describe('parseMetadata', () => {
  it('reads packages and targets relative to the component', () => {
    expect(ws.root).toBe('/ws');
    expect(ws.packages[0]?.manifest).toBe('core/Cargo.toml');
    expect(ws.packages[0]?.targets.map((t) => t.src)).toEqual([
      'core/src/lib.rs',
      'core/tests/api.rs',
    ]);
    expect(() => parseMetadata('{"packages": 1}', '/ws')).toThrow(/another shape/);
  });

  it('names test binaries the way cargo-nextest does', () => {
    const [core, app] = ws.packages;
    expect(core?.targets.map((t) => binaryId(core, t))).toEqual(['demo-core', 'demo-core::api']);
    expect(app?.targets.map((t) => binaryId(app, t))).toEqual(['demo-app::bin/demo-app']);
  });
});

describe('testFile', () => {
  const files = new Set([
    'core/src/lib.rs',
    'core/src/quiet.rs',
    'core/src/net/mod.rs',
    'core/src/net/http.rs',
  ]);
  const exists = (file: string): boolean => files.has(file);

  it('follows the module path down to the file the test is in', () => {
    expect(testFile(ws, { binary: 'demo-core', name: 'quiet::tests::night' }, exists)).toBe(
      'core/src/quiet.rs',
    );
    expect(testFile(ws, { binary: 'demo-core', name: 'net::http::tests::get' }, exists)).toBe(
      'core/src/net/http.rs',
    );
    expect(testFile(ws, { binary: 'demo-core', name: 'tests::adds' }, exists)).toBe(
      'core/src/lib.rs',
    );
    expect(testFile(ws, { binary: 'demo-core::api', name: 'adds' }, exists)).toBe(
      'core/tests/api.rs',
    );
    expect(testFile(ws, { binary: 'other', name: 'x' }, exists)).toBeUndefined();
  });
});

describe('filterFor', () => {
  it('selects a whole binary for its crate root, else the module a file holds', () => {
    expect(filterFor(ws, ['core/tests/api.rs'])).toBe('binary_id(=demo-core::api)');
    expect(filterFor(ws, ['core/src/quiet.rs'])).toBe('(binary_id(=demo-core) & test(/^quiet::/))');
    expect(filterFor(ws, ['core/src/net/mod.rs'])).toBe('(binary_id(=demo-core) & test(/^net::/))');
    expect(filterFor(ws, ['core/src/lib.rs'])).toBe('binary_id(=demo-core)');
  });

  it('selects every binary under a directory, and nothing for other files', () => {
    expect(filterFor(ws, ['core'])).toBe('binary_id(=demo-core) | binary_id(=demo-core::api)');
    expect(filterFor(ws, ['core/tests'])).toBe('binary_id(=demo-core::api)');
    expect(filterFor(ws, ['core/Cargo.toml'])).toBeUndefined();
    expect(filterFor(ws, ['docs/a.md'])).toBeUndefined();
  });

  it('turns paths into module paths', () => {
    expect(modulePath('src/net/http.rs', 'src')).toBe('net::http');
    expect(modulePath('src/a/mod.rs', 'src')).toBe('a');
    expect(modulePath('src/a', 'src')).toBe('a');
  });
});

describe('doctestFilters', () => {
  const same = (path: string): string => path;

  it('runs every doctest, all but tests.full for the commit suite, or a rerun’s files', () => {
    expect(doctestFilters(ws, { full: [] }, 'all', same)).toEqual([]);
    expect(doctestFilters(ws, { full: ['core/src/slow'] }, 'commit', same)).toEqual([
      '--skip',
      'core/src/slow',
    ]);
    expect(
      doctestFilters(
        ws,
        { full: [], files: ['core/src/quiet.rs', 'app/src/main.rs'] },
        'commit',
        same,
      ),
    ).toEqual(['core/src/quiet.rs - ']);
    expect(
      doctestFilters(ws, { full: [], files: ['app/src/main.rs'] }, 'commit', same),
    ).toBeUndefined();
  });
});
