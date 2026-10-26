import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Placed, readTree, shrinkwrap } from './shrinkwrap.js';

/** A pnpm lockfile in pnpm 10's shape: one importer, its packages and their snapshots. */
const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      app-lib:
        specifier: ^1.0.0
        version: 1.2.0
      chalk:
        specifier: ^6.0.0
        version: 6.0.1
    devDependencies:
      vitest:
        specifier: 5.0.5
        version: 5.0.5

packages:

  app-lib@1.2.0:
    resolution: {integrity: sha512-app}
    hasBin: true

  chalk@5.6.2:
    resolution: {integrity: sha512-chalk5}

  chalk@6.0.1:
    resolution: {integrity: sha512-chalk6}

  '@scope/native-linux@1.0.0':
    resolution: {integrity: sha512-linux}
    cpu: [x64]
    os: [linux]

  vitest@5.0.5:
    resolution: {integrity: sha512-vitest}

snapshots:

  app-lib@1.2.0:
    dependencies:
      chalk: 5.6.2
    optionalDependencies:
      '@scope/native-linux': 1.0.0

  chalk@5.6.2: {}

  chalk@6.0.1: {}

  '@scope/native-linux@1.0.0': {}

  vitest@5.0.5: {}
`;

const ROOT = {
  name: '@svp-labs/talos',
  version: '0.4.2',
  license: 'MIT',
  bin: { talos: 'dist/bin/talos.js' },
  engines: { node: '>=22.18' },
  dependencies: { 'app-lib': '^1.0.0', chalk: '^6.0.0' },
  devDependencies: { vitest: '5.0.5' },
};

/** The tree a hoisted install lays out: the second chalk nested under the package needing it. */
const TREE: Placed[] = [
  {
    path: 'node_modules/app-lib',
    manifest: {
      name: 'app-lib',
      version: '1.2.0',
      license: 'ISC',
      bin: 'cli.js',
      dependencies: { chalk: '^5.0.0' },
      optionalDependencies: { '@scope/native-linux': '1.0.0' },
    },
  },
  {
    path: 'node_modules/app-lib/node_modules/chalk',
    manifest: { name: 'chalk', version: '5.6.2', engines: { node: '>=12' } },
  },
  { path: 'node_modules/chalk', manifest: { name: 'chalk', version: '6.0.1' } },
  {
    path: 'node_modules/@scope/native-linux',
    manifest: { name: '@scope/native-linux', version: '1.0.0', os: ['linux'], cpu: ['x64'] },
  },
];

describe('shrinkwrap', () => {
  it('lists the tree as npm installs it, each package at its locked integrity', () => {
    const wrap = shrinkwrap(ROOT, LOCK, TREE);
    expect(wrap).toMatchObject({ name: '@svp-labs/talos', version: '0.4.2', lockfileVersion: 3 });
    expect(Object.keys(wrap.packages)).toEqual([
      '',
      'node_modules/@scope/native-linux',
      'node_modules/app-lib',
      'node_modules/app-lib/node_modules/chalk',
      'node_modules/chalk',
    ]);
    expect(wrap.packages['']).toEqual({
      name: '@svp-labs/talos',
      version: '0.4.2',
      license: 'MIT',
      bin: { talos: 'dist/bin/talos.js' },
      engines: { node: '>=22.18' },
      dependencies: { 'app-lib': '^1.0.0', chalk: '^6.0.0' },
    });
    expect(wrap.packages['node_modules/app-lib']).toEqual({
      version: '1.2.0',
      resolved: 'https://registry.npmjs.org/app-lib/-/app-lib-1.2.0.tgz',
      integrity: 'sha512-app',
      license: 'ISC',
      bin: { 'app-lib': 'cli.js' },
      dependencies: { chalk: '^5.0.0' },
      optionalDependencies: { '@scope/native-linux': '1.0.0' },
    });
    expect(wrap.packages['node_modules/app-lib/node_modules/chalk']).toEqual({
      version: '5.6.2',
      resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
      integrity: 'sha512-chalk5',
      engines: { node: '>=12' },
    });
    expect(wrap.packages['node_modules/@scope/native-linux']).toEqual({
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/@scope/native-linux/-/native-linux-1.0.0.tgz',
      integrity: 'sha512-linux',
      os: ['linux'],
      cpu: ['x64'],
      optional: true,
    });
  });

  it('refuses a tree that misses a locked package or holds one the lock lacks', () => {
    expect(() => shrinkwrap(ROOT, LOCK, TREE.slice(1))).toThrow(/app-lib@1\.2\.0/);
    const extra: Placed = { path: 'node_modules/x', manifest: { name: 'x', version: '1.0.0' } };
    expect(() => shrinkwrap(ROOT, LOCK, [...TREE, extra])).toThrow(/x@1\.0\.0/);
  });

  it('refuses a tree where a package would load another version than the lock says', () => {
    const swapped = TREE.map((placed) =>
      placed.path === 'node_modules/app-lib/node_modules/chalk'
        ? { ...placed, path: 'node_modules/other/node_modules/chalk' }
        : placed,
    );
    expect(() => shrinkwrap(ROOT, LOCK, swapped)).toThrow(/app-lib.*chalk/);
  });
});

describe('readTree', () => {
  it('reads every package of a node_modules tree, scoped and nested ones included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talos-tree-'));
    const put = async (path: string, manifest: object): Promise<void> => {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), JSON.stringify(manifest));
    };
    await put('node_modules/a/package.json', { name: 'a', version: '1.0.0' });
    await put('node_modules/a/node_modules/b/package.json', { name: 'b', version: '2.0.0' });
    await put('node_modules/@s/c/package.json', { name: '@s/c', version: '3.0.0' });
    await put('node_modules/.bin/ignored/package.json', { name: 'x', version: '0.0.0' });
    const tree = await readTree(dir);
    expect(tree.map((p) => [p.path, `${p.manifest.name}@${p.manifest.version}`])).toEqual([
      ['node_modules/@s/c', '@s/c@3.0.0'],
      ['node_modules/a', 'a@1.0.0'],
      ['node_modules/a/node_modules/b', 'b@2.0.0'],
    ]);
  });
});
