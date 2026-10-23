import { posix } from 'node:path';
import { isMap, isScalar, isSeq, parse, parseDocument, stringify, type YAMLMap } from 'yaml';
import { z } from 'zod';
import type { Component } from '../core/check.js';

/**
 * `.github/dependabot.yml`: an update entry for every ecosystem the repository has, each held by
 * a cooldown of at least a day, so Dependabot proposes only releases at least a day old. Dependabot
 * never holds a security update, which is the fast lane for urgent fixes.
 */
export const DEPENDABOT_PATH = '.github/dependabot.yml';

export type Ecosystem = { readonly ecosystem: string; readonly directories: readonly string[] };

const DAYS = z.number().int().min(1);

const defaultsSchema = z.object({
  schedule: z.looseObject({ interval: z.string() }),
  cooldown: z.looseObject({ 'default-days': DAYS }),
});

/** The settings each entry gets (`assets/dependabot/update.yml`). */
export type UpdateDefaults = z.infer<typeof defaultsSchema>;

export function parseDefaults(text: string): UpdateDefaults {
  return defaultsSchema.parse(parse(text));
}

const asDirectory = (root: string): string => (root === '.' ? '/' : `/${root}`);

function pythonEcosystem(component: Component, files: readonly string[]): string {
  return files.includes(posix.join(component.root, 'uv.lock')) ? 'uv' : 'pip';
}

const BY_LANG: Readonly<Record<string, string | undefined>> = {
  ts: 'npm',
  php: 'composer',
  rust: 'cargo',
};

/** Every ecosystem present, with the directories its manifests are in. */
export function ecosystems(
  components: readonly Component[],
  files: readonly string[],
): Ecosystem[] {
  const found = new Map<string, Set<string>>();
  const add = (ecosystem: string, directory: string): void => {
    const set = found.get(ecosystem) ?? new Set<string>();
    set.add(directory);
    found.set(ecosystem, set);
  };
  for (const component of components) {
    const ecosystem =
      component.lang === 'py' ? pythonEcosystem(component, files) : BY_LANG[component.lang];
    if (ecosystem !== undefined) add(ecosystem, asDirectory(component.root));
  }
  for (const file of files.filter((f) => /(?:^|\/)Dockerfile(?:\.[^/]+)?$/.test(f))) {
    add('docker', asDirectory(posix.dirname(file)));
  }
  add('github-actions', '/');
  return [...found].map(([ecosystem, directories]) => ({
    ecosystem,
    directories: [...directories].sort((a, b) => a.localeCompare(b)),
  }));
}

const MANIFESTS: ReadonlySet<string> = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'pyproject.toml',
  'uv.lock',
  'composer.json',
  'composer.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'Gemfile',
  'Gemfile.lock',
  'Dockerfile',
]);

function isManifest(name: string): boolean {
  return (
    MANIFESTS.has(name) ||
    /^requirements[\w.-]*\.txt$/.test(name) ||
    name.endsWith('.rockspec') ||
    name.startsWith('Dockerfile.')
  );
}

const FIXTURE = /^(?:test-projects|test-fixtures|fixtures|__fixtures__|testdata)$/;

/**
 * Folders of test fixtures that hold manifests, as `<folder>/**`: their dependencies are there to
 * be scanned or failed on, sometimes vulnerable on purpose, and never to be updated.
 */
export function fixturePaths(files: readonly string[]): string[] {
  const folders = files.flatMap((file) => {
    if (!isManifest(posix.basename(file))) return [];
    const parts = file.split('/').slice(0, -1);
    const at = parts.findIndex((part) => FIXTURE.test(part));
    return at === -1 ? [] : [parts.slice(0, at + 1).join('/')];
  });
  return [...new Set(folders)].sort((a, b) => a.localeCompare(b)).map((folder) => `${folder}/**`);
}

function entry(
  ecosystem: Ecosystem,
  defaults: UpdateDefaults,
  excluded: readonly string[],
): Record<string, unknown> {
  return {
    'package-ecosystem': ecosystem.ecosystem,
    directories: [...ecosystem.directories],
    schedule: { ...defaults.schedule },
    cooldown: { ...defaults.cooldown },
    ...(excluded.length === 0 ? {} : { 'exclude-paths': [...excluded] }),
  };
}

/** Plain YAML: every entry spelled out, no anchors a person would have to follow. */
function fresh(
  present: readonly Ecosystem[],
  defaults: UpdateDefaults,
  excluded: readonly string[],
): string {
  const updates = present.map((e) => entry(e, defaults, excluded));
  return stringify({ version: 2, updates }, { aliasDuplicateObjects: false });
}

const SEMVER_DAYS = ['semver-major-days', 'semver-minor-days', 'semver-patch-days'];

/**
 * Holds an entry a day: a cooldown when it has none, every day count raised to at least a day,
 * and no dependency exempted. `false` when it held a day already.
 */
function holdEntry(item: YAMLMap, defaults: UpdateDefaults): boolean {
  const cooldown = item.get('cooldown', true);
  if (cooldown === undefined) {
    item.set('cooldown', { ...defaults.cooldown });
    return true;
  }
  if (!isMap(cooldown)) return false;
  let changed = false;
  if (!DAYS.safeParse(cooldown.get('default-days')).success) {
    cooldown.set('default-days', defaults.cooldown['default-days']);
    changed = true;
  }
  for (const key of SEMVER_DAYS.filter((k) => cooldown.has(k))) {
    if (DAYS.safeParse(cooldown.get(key)).success) continue;
    cooldown.set(key, 1);
    changed = true;
  }
  return cooldown.delete('exclude') || changed;
}

/** Leaves the fixtures out of an entry's scan; `true` when it lacked one of them. */
function excludeFixtures(item: YAMLMap, excluded: readonly string[]): boolean {
  if (excluded.length === 0) return false;
  const current = item.get('exclude-paths', true);
  if (current === undefined) {
    item.set('exclude-paths', [...excluded]);
    return true;
  }
  if (!isSeq(current)) return false;
  const listed = new Set(current.items.map((node) => String(isScalar(node) ? node.value : node)));
  const missing = excluded.filter((path) => !listed.has(path));
  for (const path of missing) current.add(path);
  return missing.length > 0;
}

/**
 * The file's new text, or `undefined` when it is right already. An existing file keeps its
 * entries; each is held a day and leaves the fixtures out, and missing ecosystems are added.
 */
export function dependabotYml(
  existing: string | undefined,
  present: readonly Ecosystem[],
  defaults: UpdateDefaults,
  excluded: readonly string[] = [],
): string | undefined {
  if (existing === undefined) return fresh(present, defaults, excluded);
  const doc = parseDocument(existing);
  const updates = doc.get('updates');
  if (!isSeq(updates)) return fresh(present, defaults, excluded);
  let changed = false;
  const configured = new Set<string>();
  for (const item of updates.items) {
    if (!isMap(item)) continue;
    configured.add(String(item.get('package-ecosystem')));
    changed = holdEntry(item, defaults) || changed;
    changed = excludeFixtures(item, excluded) || changed;
  }
  for (const ecosystem of present.filter((e) => !configured.has(e.ecosystem))) {
    updates.add(doc.createNode(entry(ecosystem, defaults, excluded)));
    changed = true;
  }
  return changed ? doc.toString() : undefined;
}
