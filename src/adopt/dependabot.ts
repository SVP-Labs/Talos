import { posix } from 'node:path';
import { isMap, isSeq, parse, parseDocument, stringify, type YAMLMap } from 'yaml';
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

function entry(ecosystem: Ecosystem, defaults: UpdateDefaults): Record<string, unknown> {
  return {
    'package-ecosystem': ecosystem.ecosystem,
    directories: [...ecosystem.directories],
    schedule: { ...defaults.schedule },
    cooldown: { ...defaults.cooldown },
  };
}

/** Plain YAML: every entry spelled out, no anchors a person would have to follow. */
function fresh(present: readonly Ecosystem[], defaults: UpdateDefaults): string {
  const updates = present.map((e) => entry(e, defaults));
  return stringify({ version: 2, updates }, { aliasDuplicateObjects: false });
}

/** Gives an entry the cooldown when it has none; `false` when it already holds a day or more. */
function holdEntry(item: YAMLMap, defaults: UpdateDefaults): boolean {
  const cooldown = item.get('cooldown', true);
  if (cooldown === undefined) {
    item.set('cooldown', { ...defaults.cooldown });
    return true;
  }
  if (!isMap(cooldown) || DAYS.safeParse(cooldown.get('default-days')).success) return false;
  cooldown.set('default-days', defaults.cooldown['default-days']);
  return true;
}

/**
 * The file's new text, or `undefined` when it is right already. An existing file keeps its
 * entries; each gains the cooldown if it has none, and missing ecosystems are added.
 */
export function dependabotYml(
  existing: string | undefined,
  present: readonly Ecosystem[],
  defaults: UpdateDefaults,
): string | undefined {
  if (existing === undefined) return fresh(present, defaults);
  const doc = parseDocument(existing);
  const updates = doc.get('updates');
  if (!isSeq(updates)) return fresh(present, defaults);
  let changed = false;
  const configured = new Set<string>();
  for (const item of updates.items) {
    if (!isMap(item)) continue;
    configured.add(String(item.get('package-ecosystem')));
    changed = holdEntry(item, defaults) || changed;
  }
  for (const ecosystem of present.filter((e) => !configured.has(e.ecosystem))) {
    updates.add(doc.createNode(entry(ecosystem, defaults)));
    changed = true;
  }
  return changed ? doc.toString() : undefined;
}
