import { posix } from 'node:path';
import { Document, isMap, isScalar, parseDocument } from 'yaml';
import { parseManifest } from './dev-deps.js';
import type { Draft } from './draft.js';
import { npmLock, npmLockStep } from './tool-pins.js';
import type { Component } from '../core/check.js';
import { repoFacts } from '../repo/facts.js';

/**
 * pnpm's own supply-chain settings in each `pnpm-workspace.yaml` beside a pnpm lockfile (or where
 * one will be): releases at least a day old, no git or tarball dependency of a dependency, and
 * no release with less provenance than the ones before it. Also the patch that makes Stryker's
 * Vitest runner work under Vitest 5. npm and Yarn have no such settings; Talos checks their
 * lockfiles against the registry instead.
 */

const RUNNER = '@stryker-mutator/vitest-runner';
const RUNNER_VERSION = '10.0.0';
export const RUNNER_PATCH = `${RUNNER.replace('/', '__')}@${RUNNER_VERSION}.patch`;

const NOSEMGREP =
  ' nosemgrep: package_managers.pnpm.pnpm-missing-minimum-release-age.pnpm-minimum-release-age';

const GUARDS_NOTE = [
  ' Supply-chain guards: a release waits a day before it can be installed, no dependency of a',
  ' dependency comes from git or a tarball URL, and a release with less provenance than the',
  " ones before it stops the install. A day, not Semgrep's week: hijacked releases are mostly",
  ' pulled within hours, and a week would hold back security fixes as long.',
].join('\n');

const PATCH_NOTE = [
  ' Stryker\'s Vitest runner predates Vitest 5, which joins a test\'s suites with " > "; without',
  ' this patch the runner selects no tests for a mutant, and every mutant survives.',
].join('\n');

type Wanted = { readonly patch: boolean };

function addPair(doc: Document, key: string, value: unknown, note?: string): void {
  if (!isMap(doc.contents)) return;
  const keyNode = doc.createNode(key);
  if (note !== undefined) {
    keyNode.commentBefore = note;
    keyNode.spaceBefore = doc.contents.items.length > 0;
  }
  doc.contents.items.push(doc.createPair(keyNode, value));
}

function ageNode(doc: Document): unknown {
  const node = doc.createNode(1440);
  node.comment = NOSEMGREP;
  return node;
}

/** Sets the three guards that don't hold yet; `true` when something changed. */
function guard(doc: Document): boolean {
  const age = Number(doc.get('minimumReleaseAge'));
  const wrong = {
    minimumReleaseAge: Number.isNaN(age) || age < 1440,
    blockExoticSubdeps: doc.get('blockExoticSubdeps') !== true,
    trustPolicy: doc.get('trustPolicy') !== 'no-downgrade',
  };
  const values = {
    minimumReleaseAge: ageNode(doc),
    blockExoticSubdeps: true,
    trustPolicy: 'no-downgrade',
  };
  let note: string | undefined = Object.keys(wrong).every((key) => !doc.has(key))
    ? GUARDS_NOTE
    : undefined;
  for (const key of ['minimumReleaseAge', 'blockExoticSubdeps', 'trustPolicy'] as const) {
    if (!wrong[key]) continue;
    if (doc.has(key)) doc.set(key, values[key]);
    else addPair(doc, key, values[key], note);
    note = undefined;
  }
  return Object.values(wrong).some(Boolean);
}

function patch(doc: Document): boolean {
  const key = `${RUNNER}@${RUNNER_VERSION}`;
  const value = `patches/${RUNNER_PATCH}`;
  const patched = doc.get('patchedDependencies', true);
  if (patched === undefined) {
    addPair(doc, 'patchedDependencies', doc.createNode({ [key]: value }), PATCH_NOTE);
    return true;
  }
  if (!isMap(patched) || patched.has(key)) return false;
  patched.set(key, value);
  return true;
}

/**
 * The workspace file's new text, or `undefined` when it is right already or can't be read as a
 * mapping. A project's own keys and comments stay.
 */
export function pnpmWorkspace(text: string | undefined, wanted: Wanted): string | undefined {
  const parsed = parseDocument(text ?? '');
  if (parsed.errors.length > 0) return undefined;
  const empty =
    parsed.contents === null || (isScalar(parsed.contents) && parsed.contents.value === null);
  const doc: Document = empty ? new Document({}) : parsed;
  if (!isMap(doc.contents)) return undefined;
  const guarded = guard(doc);
  const patched = wanted.patch && patch(doc);
  return guarded || patched ? doc.toString({ lineWidth: 0, singleQuote: true }) : undefined;
}

/** Whether the workspace file patches the runner with the patch Talos ships. */
function pointsAtPatch(text: string | undefined): boolean {
  if (text === undefined) return false;
  const doc = parseDocument(text);
  return (
    doc.getIn(['patchedDependencies', `${RUNNER}@${RUNNER_VERSION}`]) === `patches/${RUNNER_PATCH}`
  );
}

function pinsRunner(draft: Draft, component: Component): boolean {
  const manifest = parseManifest(draft.read(posix.join(component.root, 'package.json')) ?? '');
  return ['dependencies', 'devDependencies'].some((field) => {
    const deps = manifest?.[field];
    return (
      typeof deps === 'object' && deps !== null && Reflect.get(deps, RUNNER) === RUNNER_VERSION
    );
  });
}

/** Where each TypeScript component's pnpm settings live: beside its pnpm lockfile, or will. */
function pnpmDirs(draft: Draft, components: readonly Component[], exclude: readonly string[]) {
  const files = repoFacts(draft.files(), exclude).files;
  const dirs = new Map<string, Component[]>();
  for (const file of files.filter((f) => posix.basename(f) === 'pnpm-lock.yaml')) {
    dirs.set(posix.dirname(file), []);
  }
  for (const component of components.filter((c) => c.lang === 'ts')) {
    const lock = npmLock(component.root, files);
    if (lock !== undefined && lock.lock !== 'pnpm-lock.yaml') continue;
    const dir = lock?.dir ?? component.root;
    dirs.set(dir, [...(dirs.get(dir) ?? []), component]);
  }
  return dirs;
}

/** pnpm's guards, and the Stryker runner's patch where a component pins that runner. */
export function supplyChain(
  draft: Draft,
  components: readonly Component[],
  exclude: readonly string[],
  runnerPatch: string | undefined,
): void {
  for (const [dir, governed] of pnpmDirs(draft, components, exclude)) {
    const path = posix.join(dir, 'pnpm-workspace.yaml');
    const needsPatch = runnerPatch !== undefined && governed.some((c) => pinsRunner(draft, c));
    const text = draft.read(path);
    const next = pnpmWorkspace(text, { patch: needsPatch });
    if (text !== undefined && next === undefined && parseDocument(text).errors.length > 0) {
      draft.next(
        `in ${dir}: pnpm-workspace.yaml is not YAML Talos can read; set its guards by hand`,
      );
    }
    if (next !== undefined) {
      draft.write(path, next, 'supply-chain');
      draft.next(npmLockStep(dir, draft.files()));
    }
    const patchPath = posix.join(dir, 'patches', RUNNER_PATCH);
    if (runnerPatch !== undefined && pointsAtPatch(draft.read(path)) && !draft.has(patchPath)) {
      draft.write(patchPath, runnerPatch, 'patch');
    }
  }
}
