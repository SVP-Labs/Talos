import { posix } from 'node:path';
import type { Draft } from './draft.js';
import { holdUvADay, migratePyproject, type Seed } from './python.js';
import { rustLints, rustToolchain } from './rust.js';
import { supplyChain } from './supply.js';
import { toolPins, usesRequirements } from './tool-pins.js';
import type { TalosConfig } from '../config/schema.js';
import type { Component } from '../core/check.js';
import { inComponent, inRepo } from '../core/component.js';
import type { Pack } from '../core/pack.js';
import { shadowing } from '../langs/ts/shadows.js';
import { underRoot } from '../repo/facts.js';

/**
 * What each language needs in the repository beyond its generated configs: the Python tables
 * moved out of `pyproject.toml`, pinned dev tools, the files that would shadow a TypeScript
 * base gone, LF line endings for the formatters, the Lua tree ignored, Rust's lint tables and
 * toolchain, and the package managers' supply-chain settings.
 */

const LF = '* text=auto eol=lf';
const LF_NOTE = '# Text files keep LF on every OS: the formatters write LF and check for it.';

/**
 * `.gitattributes` with every text file checked out with LF, first, so the project's own later
 * lines still win for the paths they name; `undefined` when it says so already.
 */
export function withLf(text: string | undefined): string | undefined {
  const lines = (text ?? '').split(/\r?\n/);
  if (lines.some((line) => line.trim().replaceAll(/\s+/g, ' ') === LF)) return undefined;
  const head = `${LF_NOTE}\n${LF}\n`;
  return text === undefined || text.trim() === '' ? head : `${head}${text}`;
}

function ignores(line: string, entry: string): boolean {
  const pattern = line
    .trim()
    .replace(/^(?:\*\*)?\//, '')
    .replace(/\/(?:\*\*?)?$/, '');
  return pattern === entry;
}

/** `.gitignore` with `entry/` in it; `undefined` when something ignores it already. */
export function withIgnored(text: string | undefined, entry: string): string | undefined {
  const lines = (text ?? '').split(/\r?\n/);
  if (lines.some((line) => ignores(line, entry))) return undefined;
  if (text === undefined || text === '') return `${entry}/\n`;
  return `${text}${text.endsWith('\n') ? '' : '\n'}${entry}/\n`;
}

function hasPython(draft: Draft, root: string): boolean {
  return underRoot(draft.files(), root).some((file) => file.endsWith('.py'));
}

/** Moves the tables `ruff.toml` and `pyrightconfig.json` would shadow, as their first text. */
function migratePython(draft: Draft, component: Component, seeds: Map<string, Seed>): void {
  const root = component.root;
  const path = posix.join(root, 'pyproject.toml');
  const text = draft.read(path);
  if (text === undefined || !hasPython(draft, root)) return;
  const at = (name: string): string => posix.join(root, name);
  const migration = migratePyproject(text, {
    ruff: draft.has(at('ruff.toml')) || draft.has(at('.ruff.toml')),
    pyright: draft.has(at('pyrightconfig.json')),
  });
  if (migration.manual !== undefined) {
    draft.next(`in ${root}: move pyproject.toml's tool settings by hand: ${migration.manual}`);
  }
  if (migration.text !== undefined) draft.write(path, migration.text, 'migration');
  for (const [name, seed] of migration.seeds) seeds.set(at(name), seed);
}

function holdUv(draft: Draft, component: Component): void {
  const root = component.root;
  const path = posix.join(root, 'pyproject.toml');
  const text = draft.read(path);
  if (text === undefined || usesRequirements(root, draft.files())) return;
  const held = holdUvADay(text);
  if (held.manual !== undefined) {
    draft.next(`in ${root}: set [tool.uv] exclude-newer by hand: ${held.manual}`);
  }
  if (held.text === undefined) return;
  draft.write(path, held.text, 'supply-chain');
  draft.next(`in ${root}: uv lock`);
}

function removeShadows(draft: Draft, component: Component): void {
  const root = component.root;
  const local = draft.files().flatMap((file) => inComponent(root, file) ?? []);
  for (const { file } of shadowing(local)) draft.remove(inRepo(root, file), 'shadowed');
}

function edit(
  draft: Draft,
  path: string,
  change: (text: string | undefined) => string | undefined,
  why: 'line-endings' | 'ignore',
): void {
  const next = change(draft.read(path));
  if (next !== undefined) draft.write(path, next, why);
}

const AFTER_PINS: Readonly<
  Record<Component['lang'], (draft: Draft, component: Component) => void>
> = {
  ts: removeShadows,
  py: holdUv,
  php: () => undefined,
  lua: (draft) => {
    edit(draft, '.gitignore', (text) => withIgnored(text, '.lua'), 'ignore');
  },
  rust: (draft, component) => {
    rustLints(draft, component);
    rustToolchain(draft, component);
  },
};

export type LanguageAssets = {
  /** The Stryker Vitest runner's patch, when this Talos ships it. */
  readonly runnerPatch: string | undefined;
};

/**
 * Every language's files, in the order they build on each other: Python's tables move before
 * its pins go into `pyproject.toml`. Returns the first text of the extension files the moved
 * tables fill, by their repository path.
 */
export function languageSteps(
  draft: Draft,
  config: TalosConfig,
  packs: readonly Pack[],
  assets: LanguageAssets,
): ReadonlyMap<string, Seed> {
  const seeds = new Map<string, Seed>();
  const components = config.components;
  for (const component of components.filter((c) => c.lang === 'py')) {
    migratePython(draft, component, seeds);
  }
  toolPins(draft, components, packs);
  for (const component of components) AFTER_PINS[component.lang](draft, component);
  if (components.some((c) => c.lang === 'ts' || c.lang === 'lua')) {
    edit(draft, '.gitattributes', withLf, 'line-endings');
  }
  supplyChain(draft, components, config.exclude, assets.runnerPatch);
  return seeds;
}
