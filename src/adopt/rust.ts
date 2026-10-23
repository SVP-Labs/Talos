import { posix } from 'node:path';
import picomatch from 'picomatch';
import type { Draft } from './draft.js';
import {
  bodyEnd,
  eolOf,
  insertLines,
  joinToml,
  keyLine,
  parsedToml,
  replaceLine,
  sameToml,
  splitToml,
  type TomlSection,
} from './toml-text.js';
import type { Component } from '../core/check.js';
import { BASE_LINTS, type BaseLint, isLevel, type Level, lintsBlock, weakerThan } from '../langs/rust/lints.js';
import { toolchainFile } from '../langs/rust/toolchain.js';

/**
 * A Rust component as Talos wants it: the lint levels the gate holds it to written into its
 * manifests, so the editor shows what the gate reports, and its toolchain pinned to an exact
 * release with the components the checks use.
 */

/** The release a new toolchain file pins; an exact pin a project already has stays. */
export const RUST_CHANNEL = '1.99.1';

const COMPONENTS = ['clippy', 'rustfmt', 'llvm-tools'];

type Table = Record<string, unknown>;
type Edit = { readonly text?: string; readonly manual?: string };

const isTable = (value: unknown): value is Table =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function tableIn(parsed: unknown, path: readonly string[]): Table | undefined {
  let at: unknown = parsed;
  for (const key of path) at = isTable(at) ? at[key] : undefined;
  return isTable(at) ? at : undefined;
}

function levelOf(value: unknown): Level | undefined {
  if (isLevel(value)) return value;
  return isTable(value) && isLevel(value.level) ? value.level : undefined;
}

function entryValue(lint: BaseLint): string | Table {
  return lint.priority === undefined ? lint.level : { level: lint.level, priority: lint.priority };
}

function entryLine(lint: BaseLint): string {
  const value =
    lint.priority === undefined
      ? JSON.stringify(lint.level)
      : `{ level = ${JSON.stringify(lint.level)}, priority = ${String(lint.priority)} }`;
  return `${lint.name} = ${value}`;
}

function appended(sections: readonly TomlSection[], lines: readonly string[]): TomlSection[] {
  const last = sections.at(-1)?.lines.at(-1);
  const all = [...(last === undefined || last.trim() === '' ? [] : ['']), ...lines];
  return [...sections, { name: undefined, array: false, lines: all, top: all.map(() => true) }];
}

type Needs = { readonly tool: BaseLint['tool']; readonly lints: readonly BaseLint[] };

function needed(current: Table | undefined): Needs[] {
  return (['rust', 'clippy'] as const).flatMap((tool) => {
    const have = tableIn(current, [tool]);
    const lints = BASE_LINTS.filter((lint) => lint.tool === tool).filter((lint) => {
      const level = levelOf(have?.[lint.name]);
      return level === undefined || weakerThan(level, lint.level);
    });
    return lints.length === 0 ? [] : [{ tool, lints }];
  });
}

/** The sections with one tool's missing or weaker lints written into its table. */
function withTool(
  sections: readonly TomlSection[],
  name: string,
  needs: Needs,
  exists: boolean,
): TomlSection[] | undefined {
  const index = sections.findIndex((s) => s.name === name && !s.array);
  const found = sections[index];
  if (found === undefined) {
    return exists ? undefined : appended(sections, [`[${name}]`, ...needs.lints.map(entryLine)]);
  }
  let section = found;
  for (const lint of needs.lints) {
    const at = keyLine(section, lint.name);
    section =
      at === -1
        ? insertLines(section, bodyEnd(section), [entryLine(lint)])
        : replaceLine(section, at, entryLine(lint));
  }
  return sections.map((s, i) => (i === index ? section : s));
}

function expected(parsed: Table, path: readonly string[], all: readonly Needs[]): Table {
  const copy: Table = structuredClone(parsed);
  let at: Table = copy;
  for (const key of path) {
    const inner = isTable(at[key]) ? at[key] : {};
    at[key] = inner;
    at = inner;
  }
  for (const needs of all) {
    const tool = isTable(at[needs.tool]) ? at[needs.tool] : {};
    for (const lint of needs.lints) tool[lint.name] = entryValue(lint);
    at[needs.tool] = tool;
  }
  return copy;
}

/**
 * The manifest with Talos's lint levels in `table` (`lints`, or `workspace.lints` in a
 * workspace's root): a missing lint is added, a weaker level raised, and anything else the
 * project set, stricter levels included, stays.
 */
export function withLints(text: string, table: 'lints' | 'workspace.lints'): Edit {
  const parsed = parsedToml(text);
  if (parsed === undefined) return { manual: 'Cargo.toml is not valid TOML' };
  const path = table.split('.');
  const current = tableIn(parsed, path);
  const all = needed(current);
  if (all.length === 0) return {};
  let next: string;
  if (current === undefined) {
    next = joinToml(appended(splitToml(text), lintsBlock(table).trimEnd().split('\n')), eolOf(text));
  } else {
    let sections: TomlSection[] | undefined = splitToml(text);
    for (const needs of all) {
      const exists = tableIn(current, [needs.tool]) !== undefined;
      sections = sections && withTool(sections, `${table}.${needs.tool}`, needs, exists);
    }
    if (sections === undefined) return { manual: `its [${table}] is laid out unusually` };
    next = joinToml(sections, eolOf(text));
  }
  const reparsed = parsedToml(next);
  return reparsed !== undefined && sameToml(reparsed, expected(parsed, path, all))
    ? { text: next }
    : { manual: `its [${table}] could not be edited safely` };
}

/** `[lints] workspace = true`, so a workspace member takes the workspace's levels. */
function withWorkspaceLints(text: string): Edit {
  const parsed = parsedToml(text);
  if (parsed === undefined) return { manual: 'Cargo.toml is not valid TOML' };
  const lints = tableIn(parsed, ['lints']);
  if (lints?.workspace === true) return {};
  if (lints !== undefined) return withLints(text, 'lints');
  const next = joinToml(appended(splitToml(text), ['[lints]', 'workspace = true']), eolOf(text));
  return { text: next };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The manifests of a workspace's members, from its `members` and `exclude` globs. */
function members(root: string, workspace: Table, files: readonly string[]): string[] {
  const included = picomatch(strings(workspace.members), { dot: true });
  const excluded = picomatch(strings(workspace.exclude), { dot: true });
  return files.filter((file) => {
    if (posix.basename(file) !== 'Cargo.toml') return false;
    const dir = posix.relative(root, posix.dirname(file));
    return dir !== '' && !dir.startsWith('..') && included(dir) && !excluded(dir);
  });
}

function apply(draft: Draft, path: string, edit: Edit, root: string): void {
  if (edit.text !== undefined) draft.write(path, edit.text, 'lints');
  if (edit.manual !== undefined) {
    draft.next(`in ${root}: write Talos's lint levels into ${path} by hand: ${edit.manual}`);
  }
}

/** Every manifest of the component gets the lint levels, the workspace's way or its own. */
export function rustLints(draft: Draft, component: Component): void {
  const manifest = posix.join(component.root, 'Cargo.toml');
  const text = draft.read(manifest);
  if (text === undefined) return;
  const workspace = tableIn(parsedToml(text), ['workspace']);
  if (workspace === undefined) {
    apply(draft, manifest, withLints(text, 'lints'), component.root);
    return;
  }
  apply(draft, manifest, withLints(text, 'workspace.lints'), component.root);
  const rootText = draft.read(manifest) ?? text;
  if (tableIn(parsedToml(rootText), ['package']) !== undefined) {
    apply(draft, manifest, withWorkspaceLints(rootText), component.root);
  }
  for (const member of members(component.root, workspace, draft.files())) {
    const memberText = draft.read(member);
    if (memberText !== undefined) apply(draft, member, withWorkspaceLints(memberText), component.root);
  }
}

function toolchainText(channel: string, components: readonly string[]): string {
  return [
    '[toolchain]',
    `channel = ${JSON.stringify(channel)}`,
    `components = [${components.map((c) => JSON.stringify(c)).join(', ')}]`,
    'profile = "minimal"',
    '',
  ].join('\n');
}

const EXACT = /^\d+\.\d+\.\d+$/;

/** The toolchain file with an exact channel and every component the checks use. */
export function pinToolchain(text: string): Edit {
  const parsed = parsedToml(text);
  const table = tableIn(parsed, ['toolchain']);
  if (parsed === undefined || table === undefined) {
    return { manual: 'its rust-toolchain.toml has no [toolchain] table' };
  }
  const channel = typeof table.channel === 'string' && EXACT.test(table.channel) ? table.channel : RUST_CHANNEL;
  const have = strings(table.components);
  const components = [...have, ...COMPONENTS.filter((c) => !have.includes(c))];
  if (channel === table.channel && components.length === have.length) return {};
  const lines = {
    channel: `channel = ${JSON.stringify(channel)}`,
    components: `components = [${components.map((c) => JSON.stringify(c)).join(', ')}]`,
  };
  const sections = splitToml(text).map((section) => {
    if (section.name !== 'toolchain') return section;
    let out = section;
    for (const key of ['channel', 'components'] as const) {
      const at = keyLine(out, key);
      const header = out.lines.findIndex((line, i) => out.top[i] && /^\s*\[/.test(line));
      out = at === -1 ? insertLines(out, header + 1, [lines[key]]) : replaceLine(out, at, lines[key]);
    }
    return out;
  });
  const next = joinToml(sections, eolOf(text));
  const wanted = { ...parsed, toolchain: { ...table, channel, components } };
  const reparsed = parsedToml(next);
  return reparsed !== undefined && sameToml(reparsed, wanted)
    ? { text: next }
    : { manual: 'its rust-toolchain.toml could not be edited safely' };
}

/**
 * The toolchain file rustup reads for the component: its own or the nearest above it, written
 * at its root when there is none. The legacy one-line `rust-toolchain` becomes the TOML file.
 */
export function rustToolchain(draft: Draft, component: Component): void {
  const found = toolchainFile(component.root, new Set(draft.files()));
  const at = posix.join(component.root, 'rust-toolchain.toml');
  if (found === undefined) {
    draft.write(at, toolchainText(RUST_CHANNEL, COMPONENTS), 'toolchain');
    return;
  }
  const text = draft.read(found) ?? '';
  if (posix.basename(found) === 'rust-toolchain') {
    const legacy = text.trim();
    const channel = EXACT.test(legacy) ? legacy : RUST_CHANNEL;
    draft.remove(found, 'migrated');
    draft.write(`${found}.toml`, toolchainText(channel, COMPONENTS), 'toolchain');
    return;
  }
  const edit = pinToolchain(text);
  if (edit.text !== undefined) draft.write(found, edit.text, 'toolchain');
  if (edit.manual !== undefined) draft.next(`in ${component.root}: pin the toolchain by hand: ${edit.manual}`);
}
