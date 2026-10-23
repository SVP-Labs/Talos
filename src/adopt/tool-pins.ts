import { posix } from 'node:path';
import {
  type Manifest,
  manifestText,
  parseManifest,
  pinManifest,
  pinPythonProject,
  pinRequirementsIn,
} from './dev-deps.js';
import type { Draft } from './draft.js';
import { composerSettings, isLaravel } from './php.js';
import type { Component } from '../core/check.js';
import type { DevTools, Pack } from '../core/pack.js';
import { pinsFor } from '../langs/php/toolchain.js';

/**
 * Pins each component's dev tools at the versions its language pack runs, in the project's own
 * manifest, and names the lockfile refresh that must follow. Adoption runs no package manager
 * itself: whoever holds a token never runs repository code, so the refresh is the next step of
 * whoever commits.
 */

type Pins = Readonly<Record<string, string>>;

/** The Node.js types the initial `tsconfig.json` loads, pinned when the project has none. */
export const TYPES_NODE = '22.20.5';

const NPM_LOCKS: readonly [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm install --lockfile-only'],
  ['package-lock.json', 'npm install --package-lock-only'],
  ['yarn.lock', 'yarn install --mode update-lockfile'],
];

export function ancestors(dir: string): string[] {
  const out = [dir];
  for (let at = dir; at !== '.';) {
    at = posix.dirname(at);
    out.push(at);
  }
  return out;
}

/** The npm lockfile governing a component, nearest first, and the directory it is in. */
export function npmLock(root: string, files: readonly string[]): { dir: string; lock: string } | undefined {
  for (const dir of ancestors(root)) {
    for (const [lock] of NPM_LOCKS) {
      if (files.includes(posix.join(dir, lock))) return { dir, lock };
    }
  }
  return undefined;
}

/** The command that refreshes the npm lockfile governing a component, run where it lives. */
export function npmLockStep(root: string, files: readonly string[]): string {
  const found = npmLock(root, files);
  if (found === undefined) return `in ${root}: pnpm install --lockfile-only, and commit pnpm-lock.yaml`;
  const command = NPM_LOCKS.find(([lock]) => lock === found.lock)?.[1] ?? '';
  return `in ${found.dir}: ${command}`;
}

type Pinner = (draft: Draft, component: Component, packages: Pins) => void;

/** A JSON manifest edited as an object: pinned, then whatever else its language needs. */
function jsonPinner(
  file: string,
  edit: (manifest: Manifest, packages: Pins) => Manifest,
  next: (draft: Draft, root: string) => string,
): Pinner {
  return (draft, component, packages) => {
    const path = posix.join(component.root, file);
    const text = draft.read(path);
    const manifest = text === undefined ? undefined : parseManifest(text);
    if (text === undefined || manifest === undefined) {
      draft.next(`in ${component.root}: add a ${file} Talos can read, then rerun`);
      return;
    }
    const edited = edit(manifest, packages);
    if (edited === manifest) return;
    draft.write(path, manifestText(edited, text), 'dev-dependencies');
    draft.next(next(draft, component.root));
  };
}

const NPM_FIELDS = { dev: 'devDependencies', runtime: 'dependencies' };

/**
 * `package.json`: the pins, `@types/node` when the project has none, and no `prettier` key,
 * which Prettier would read instead of the base.
 */
function npmManifest(manifest: Manifest, packages: Pins): Manifest {
  const listed = [manifest.dependencies, manifest.devDependencies].some(
    (deps) => typeof deps === 'object' && deps !== null && '@types/node' in deps,
  );
  const pinned = pinManifest(manifest, NPM_FIELDS, {
    ...packages,
    ...(listed ? {} : { '@types/node': TYPES_NODE }),
  });
  if (!('prettier' in pinned)) return pinned;
  const { prettier: _, ...rest } = pinned;
  return rest;
}

/** `composer.json`: the pins (Larastan only with Laravel) and the settings the tools need. */
function composerManifest(manifest: Manifest, packages: Pins): Manifest {
  const pins = Object.fromEntries(
    Object.entries(pinsFor(isLaravel(manifest))).filter(([name]) => name in packages),
  );
  const pinned = pinManifest(manifest, { dev: 'require-dev', runtime: 'require' }, pins);
  const settled = composerSettings(pinned);
  return JSON.stringify(settled) === JSON.stringify(manifest) ? manifest : settled;
}

function dirOf(file: string): string {
  const dir = posix.dirname(file);
  return dir === '' ? '.' : dir;
}

/**
 * Where a Python component's dev tools go is where its install reads them from: `uv.lock` means
 * the `dev` group in `pyproject.toml`; hashed `requirements*.txt` mean `requirements-dev.in`,
 * compiled with hashes after; a project with neither gets the group and a first `uv.lock`.
 */
export function usesRequirements(root: string, files: readonly string[]): boolean {
  if (files.includes(posix.join(root, 'uv.lock'))) return false;
  return files.some(
    (file) => dirOf(file) === root && /^requirements[\w.-]*\.txt$/.test(posix.basename(file)),
  );
}

const pythonPinner: Pinner = (draft, component, packages) => {
  const root = component.root;
  const pyproject = posix.join(root, 'pyproject.toml');
  const text = draft.read(pyproject);
  if (text !== undefined && !usesRequirements(root, draft.files())) {
    const pinned = pinPythonProject(text, packages);
    if (pinned.kind === 'manual') draft.next(`in ${root}: pin the dev tools by hand: ${pinned.reason}`);
    if (pinned.kind !== 'changed') return;
    draft.write(pyproject, pinned.text, 'dev-dependencies');
    draft.next(`in ${root}: uv lock`);
    return;
  }
  const path = posix.join(root, 'requirements-dev.in');
  const content = pinRequirementsIn(draft.read(path), packages);
  if (content === undefined) return;
  draft.write(path, content, 'dev-dependencies');
  draft.next(`in ${root}: uv pip compile --generate-hashes requirements-dev.in -o requirements-dev.txt`);
};

const PINNERS: Readonly<Record<DevTools['manager'], Pinner>> = {
  npm: jsonPinner('package.json', npmManifest, (draft, root) => npmLockStep(root, draft.files())),
  composer: jsonPinner('composer.json', composerManifest, (_, root) => `in ${root}: composer update --lock`),
  pypi: pythonPinner,
  cargo: (draft, component, packages) => {
    draft.next(`in ${component.root}: pin ${Object.keys(packages).join(', ')} by hand`);
  },
  // Talos installs the Lua tree's tools from its own lockfile, not the project's rockspec.
  luarocks: () => undefined,
};

/** Each component's dev dependencies pinned at the versions its language pack runs. */
export function toolPins(draft: Draft, components: readonly Component[], packs: readonly Pack[]): void {
  for (const component of components) {
    const devTools = packs.find((pack) => pack.lang === component.lang)?.devTools;
    if (devTools !== undefined) PINNERS[devTools.manager](draft, component, devTools.packages);
  }
}
