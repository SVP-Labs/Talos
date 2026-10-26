import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * The `npm-shrinkwrap.json` a release ships. npm installs a published package's shrinkwrap as
 * it stands, so every install of the release gets the dependency tree `pnpm-lock.yaml` locked,
 * overrides and the release-age wait included, rather than whatever its ranges reach that day.
 * The tree comes from a hoisted install of the lockfile's production dependencies, every
 * platform's optional packages included, so npm's layout is pnpm's and needs no resolving.
 */

const record = z.record(z.string(), z.string());

const manifestSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  license: z.string().optional().catch(undefined),
  bin: z.union([z.string(), record]).optional().catch(undefined),
  engines: record.optional().catch(undefined),
  os: z.array(z.string()).optional().catch(undefined),
  cpu: z.array(z.string()).optional().catch(undefined),
  libc: z.array(z.string()).optional().catch(undefined),
  dependencies: record.optional(),
  optionalDependencies: record.optional(),
  peerDependencies: record.optional(),
  peerDependenciesMeta: z.record(z.string(), z.unknown()).optional(),
});

export type Manifest = z.input<typeof manifestSchema>;

/** A package where a hoisted install put it: `node_modules/a/node_modules/b`. */
export type Placed = { readonly path: string; readonly manifest: Manifest };

const versions = z.record(z.string(), z.object({ version: z.string() }));

const lockSchema = z.object({
  importers: z.object({
    '.': z.object({
      dependencies: versions.default({}),
      optionalDependencies: versions.default({}),
    }),
  }),
  packages: z.record(
    z.string(),
    z.object({ resolution: z.object({ integrity: z.string(), tarball: z.string().optional() }) }),
  ),
  snapshots: z.record(
    z.string(),
    z
      .object({ dependencies: record.default({}), optionalDependencies: record.default({}) })
      .nullish(),
  ),
});

type Lock = z.infer<typeof lockSchema>;

/** `name@version`, without the peer context pnpm adds to a snapshot's key. */
function idOf(key: string): string {
  const peers = key.indexOf('(');
  return peers < 0 ? key : key.slice(0, peers);
}

/** Each production package's dependencies, by name, with the version the lock gives each. */
type Graph = ReadonlyMap<string, ReadonlyMap<string, { readonly id: string; optional: boolean }>>;

function graphOf(lock: Lock): Graph {
  const graph = new Map<string, Map<string, { id: string; optional: boolean }>>();
  for (const [key, snapshot] of Object.entries(lock.snapshots)) {
    const deps = graph.get(idOf(key)) ?? new Map<string, { id: string; optional: boolean }>();
    for (const [name, version] of Object.entries(snapshot?.dependencies ?? {})) {
      deps.set(name, { id: idOf(`${name}@${version}`), optional: false });
    }
    for (const [name, version] of Object.entries(snapshot?.optionalDependencies ?? {})) {
      deps.set(name, { id: idOf(`${name}@${version}`), optional: true });
    }
    graph.set(idOf(key), deps);
  }
  return graph;
}

/**
 * The production packages, each `true` when some chain of required dependencies reaches it and
 * `false` when only optional ones do, which npm may skip on a platform that can't take it.
 */
function production(lock: Lock, graph: Graph): Map<string, boolean> {
  const required = new Map<string, boolean>();
  const importer = lock.importers['.'];
  const queue: [string, boolean][] = [
    ...Object.entries(importer.dependencies).map(([n, d]): [string, boolean] => [
      `${n}@${d.version}`,
      true,
    ]),
    ...Object.entries(importer.optionalDependencies).map(([n, d]): [string, boolean] => [
      `${n}@${d.version}`,
      false,
    ]),
  ];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [id, needed] = [idOf(next[0]), next[1]];
    const known = required.get(id);
    if (known === true || (known === false && !needed)) continue;
    required.set(id, needed);
    for (const dep of graph.get(id)?.values() ?? []) queue.push([dep.id, needed && !dep.optional]);
  }
  return required;
}

/** Where Node and npm find `name` from a package at `from`: the nearest `node_modules` up. */
function located(at: ReadonlyMap<string, string>, from: string, name: string): string | undefined {
  let dir = from;
  for (;;) {
    const found = at.get(dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`);
    if (found !== undefined || dir === '') return found;
    const parent = dir.lastIndexOf('/node_modules/');
    dir = parent < 0 ? '' : dir.slice(0, parent);
  }
}

function refuse(problem: string): never {
  throw new Error(`the installed tree doesn't match pnpm-lock.yaml: ${problem}`);
}

/**
 * Every package is in the lock and every production package is in the tree, each loading the
 * versions the lock gives its dependencies.
 */
function check(tree: readonly Placed[], wanted: ReadonlyMap<string, boolean>, graph: Graph): void {
  const at = new Map(tree.map((p) => [p.path, `${p.manifest.name}@${p.manifest.version}`]));
  const present = new Set(at.values());
  const extra = [...present].find((id) => !wanted.has(id));
  if (extra !== undefined) refuse(`${extra} is not a locked production package`);
  const missing = [...wanted.keys()].find((id) => !present.has(id));
  if (missing !== undefined) refuse(`${missing} is not installed`);
  for (const placed of tree) {
    const id = `${placed.manifest.name}@${placed.manifest.version}`;
    for (const [name, dep] of graph.get(id) ?? []) {
      const loaded = located(at, placed.path, name);
      if (loaded !== dep.id) {
        refuse(`${id} would load ${name} as ${loaded ?? 'nothing'}, not ${dep.id}`);
      }
    }
  }
}

function registryTarball(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${posix.basename(name)}-${version}.tgz`;
}

/** npm writes `bin` as a map; a single path is named after the package. */
function bins(manifest: Manifest): Record<string, string> | undefined {
  const bin = manifest.bin;
  return typeof bin === 'string' ? { [posix.basename(manifest.name)]: bin } : bin;
}

/** The fields npm's lockfile carries for a package, those the manifest has, in npm's order. */
function described(manifest: Manifest): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    license: manifest.license,
    bin: bins(manifest),
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
    peerDependenciesMeta: manifest.peerDependenciesMeta,
    engines: manifest.engines,
    os: manifest.os,
    cpu: manifest.cpu,
    libc: manifest.libc,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export type Shrinkwrap = {
  readonly name: string;
  readonly version: string;
  readonly lockfileVersion: 3;
  readonly requires: true;
  readonly packages: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

/** The shrinkwrap of `root` (Talos's own `package.json`) from its lock and its installed tree. */
export function shrinkwrap(root: Manifest, lockText: string, tree: readonly Placed[]): Shrinkwrap {
  const lock = lockSchema.parse(parse(lockText));
  const graph = graphOf(lock);
  const wanted = production(lock, graph);
  check(tree, wanted, graph);
  const packages: Record<string, Record<string, unknown>> = {
    '': {
      name: root.name,
      version: root.version,
      ...described({ ...root, dependencies: root.dependencies ?? {} }),
    },
  };
  for (const placed of [...tree].sort((a, b) => a.path.localeCompare(b.path))) {
    const { name, version } = placed.manifest;
    const resolution = lock.packages[`${name}@${version}`]?.resolution;
    if (resolution === undefined) {
      refuse(`${name}@${version} has no resolution`);
    }
    packages[placed.path] = {
      version,
      resolved: resolution.tarball ?? registryTarball(name, version),
      integrity: resolution.integrity,
      ...described(placed.manifest),
      ...(wanted.get(`${name}@${version}`) === true ? {} : { optional: true }),
    };
  }
  return { name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages };
}

/** Every package under `dir/node_modules`, nested ones too, by path. */
export async function readTree(dir: string): Promise<Placed[]> {
  const placed: Placed[] = [];
  const visit = async (path: string): Promise<void> => {
    const text = await readFile(join(dir, path, 'package.json'), 'utf8');
    placed.push({ path, manifest: manifestSchema.parse(JSON.parse(text)) });
    await walk(`${path}/node_modules`);
  };
  const walk = async (modules: string): Promise<void> => {
    const entries = await readdir(join(dir, modules), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))) {
      if (!entry.name.startsWith('@')) {
        await visit(`${modules}/${entry.name}`);
        continue;
      }
      const scoped = await readdir(join(dir, modules, entry.name), { withFileTypes: true });
      for (const inner of scoped.filter((e) => e.isDirectory())) {
        await visit(`${modules}/${entry.name}/${inner.name}`);
      }
    }
  };
  await walk('node_modules');
  return placed.sort((a, b) => a.path.localeCompare(b.path));
}

/** The shrinkwrap of the hoisted install in `dir`, beside its `package.json` and lockfile. */
export async function shrinkwrapOf(dir: string): Promise<Shrinkwrap> {
  const root = manifestSchema.parse(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')));
  const lock = await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8');
  return shrinkwrap(root, lock, await readTree(dir));
}
