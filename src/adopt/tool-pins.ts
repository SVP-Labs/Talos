import { posix } from 'node:path';
import { pinJsonManifest, pinPythonProject, pinRequirementsIn } from './dev-deps.js';
import type { Reader } from './scaffold.js';
import type { Component } from '../core/check.js';
import type { DevTools, Pack } from '../core/pack.js';

/** A file adoption writes, and why. */
export type PlannedFile = {
  readonly path: string;
  readonly content: string;
  readonly why:
    | 'talos.yml'
    | 'generated'
    | 'extension'
    | 'claude'
    | 'issue-form'
    | 'pr-template'
    | 'dependabot'
    | 'dev-dependencies'
    | 'brief';
};

export type ToolPins = { readonly files: PlannedFile[]; readonly next: string[] };

const NPM_LOCKS: readonly [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm install --lockfile-only'],
  ['package-lock.json', 'npm install --package-lock-only'],
  ['yarn.lock', 'yarn install --mode update-lockfile'],
];

function ancestors(dir: string): string[] {
  const out = [dir];
  for (let at = dir; at !== '.';) {
    at = posix.dirname(at);
    out.push(at);
  }
  return out;
}

/** The command that refreshes the npm lockfile governing a component, run where it lives. */
export function npmLockStep(root: string, files: readonly string[]): string {
  for (const dir of ancestors(root)) {
    for (const [lock, command] of NPM_LOCKS) {
      if (files.includes(posix.join(dir, lock))) return `in ${dir}: ${command}`;
    }
  }
  return `in ${root}: pnpm install --lockfile-only, and commit pnpm-lock.yaml`;
}

type Pins = Readonly<Record<string, string>>;

type Pinner = (component: Component, packages: Pins) => ToolPins;

function jsonPinner(
  files: readonly string[],
  read: Reader,
  manifest: { readonly file: string; readonly dev: string; readonly runtime: string },
  next: (root: string) => string,
): Pinner {
  return (component, packages) => {
    const path = posix.join(component.root, manifest.file);
    const text = files.includes(path) ? read(path) : undefined;
    if (text === undefined) {
      return { files: [], next: [`in ${component.root}: add ${manifest.file}, then rerun`] };
    }
    const content = pinJsonManifest(text, manifest, packages);
    if (content === undefined) return { files: [], next: [] };
    return { files: [{ path, content, why: 'dev-dependencies' }], next: [next(component.root)] };
  };
}

/**
 * Where a Python component's dev tools go is where its install reads them from: `uv.lock` means
 * the `dev` group in `pyproject.toml`; hashed `requirements*.txt` mean `requirements-dev.in`,
 * compiled with hashes after; a project with neither gets the group and a first `uv.lock`.
 */
function usesRequirements(root: string, files: readonly string[]): boolean {
  if (files.includes(posix.join(root, 'uv.lock'))) return false;
  return files.some(
    (file) => dirOf(file) === root && /^requirements[\w.-]*\.txt$/.test(posix.basename(file)),
  );
}

function dirOf(file: string): string {
  const dir = posix.dirname(file);
  return dir === '' ? '.' : dir;
}

function pyprojectPins(path: string, text: string, packages: Pins, root: string): ToolPins {
  const pinned = pinPythonProject(text, packages);
  if (pinned.kind === 'unchanged') return { files: [], next: [] };
  if (pinned.kind === 'manual') {
    return { files: [], next: [`in ${root}: pin the dev tools by hand: ${pinned.reason}`] };
  }
  return {
    files: [{ path, content: pinned.text, why: 'dev-dependencies' }],
    next: [`in ${root}: uv lock`],
  };
}

function pythonPinner(files: readonly string[], read: Reader): Pinner {
  return (component, packages) => {
    const root = component.root;
    const pyproject = posix.join(root, 'pyproject.toml');
    const text = files.includes(pyproject) ? read(pyproject) : undefined;
    if (text !== undefined && !usesRequirements(root, files)) {
      return pyprojectPins(pyproject, text, packages, root);
    }
    const path = posix.join(root, 'requirements-dev.in');
    const content = pinRequirementsIn(files.includes(path) ? read(path) : undefined, packages);
    if (content === undefined) return { files: [], next: [] };
    const compile = 'uv pip compile --generate-hashes requirements-dev.in -o requirements-dev.txt';
    return {
      files: [{ path, content, why: 'dev-dependencies' }],
      next: [`in ${root}: ${compile}`],
    };
  };
}

function pinners(files: readonly string[], read: Reader): Record<DevTools['manager'], Pinner> {
  const byHand: Pinner = (component, packages) => ({
    files: [],
    next: [`in ${component.root}: pin ${Object.keys(packages).join(', ')} by hand`],
  });
  return {
    npm: jsonPinner(
      files,
      read,
      { file: 'package.json', dev: 'devDependencies', runtime: 'dependencies' },
      (root) => npmLockStep(root, files),
    ),
    composer: jsonPinner(
      files,
      read,
      { file: 'composer.json', dev: 'require-dev', runtime: 'require' },
      (root) => `in ${root}: composer update --lock`,
    ),
    pypi: pythonPinner(files, read),
    cargo: byHand,
    luarocks: byHand,
  };
}

/**
 * Each component's dev dependencies pinned at the versions its language pack runs, and the
 * lockfile refreshes that must follow. Adoption runs no package manager itself: whoever holds a
 * token never runs repository code, so the refresh is the next step of whoever commits.
 */
export function toolPins(
  components: readonly Component[],
  packs: readonly Pack[],
  files: readonly string[],
  read: Reader,
): ToolPins {
  const byManager = pinners(files, read);
  const out: ToolPins = { files: [], next: [] };
  for (const component of components) {
    const devTools = packs.find((pack) => pack.lang === component.lang)?.devTools;
    if (devTools === undefined) continue;
    const pinned = byManager[devTools.manager](component, devTools.packages);
    out.files.push(...pinned.files);
    out.next.push(...pinned.next.filter((step) => !out.next.includes(step)));
  }
  return out;
}
