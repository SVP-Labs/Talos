import { type Document, isMap, parse, parseDocument } from 'yaml';
import type { Additions } from './security.js';
import type { Component } from '../core/check.js';

/**
 * `talos.yml` as `talos adopt` first writes it: the name, the prefix, the components it found,
 * its guesses at what to exclude, the docs paths and an empty supply chain. Everything else
 * keeps the schema's defaults until someone edits the file.
 */
export type Draft = {
  readonly name: string;
  readonly prefix: string;
  readonly components: readonly Component[];
  readonly exclude: readonly string[];
  readonly docs: { readonly glossary: string; readonly briefs: string };
};

/** A YAML scalar: plain when that is safe in a flow collection, else JSON-quoted. */
export function scalar(text: string): string {
  return /^[A-Za-z0-9_.][\w./-]*$/.test(text) ? text : JSON.stringify(text);
}

function list(items: readonly string[]): string {
  return `[${items.map(scalar).join(', ')}]`;
}

function componentLine(component: Component): string {
  const os =
    component.os.length === 1 && component.os[0] === 'linux' ? '' : `, os: ${list(component.os)}`;
  return `  - { lang: ${component.lang}, root: ${scalar(component.root)}${os} }`;
}

export function renderTalosYml(draft: Draft): string {
  const components =
    draft.components.length === 0
      ? 'components: []'
      : ['components:', ...draft.components.map(componentLine)].join('\n');
  return [
    "# Talos's settings for this repository. Changes to it need the owner's approval.",
    `name: ${scalar(draft.name)}`,
    `prefix: ${draft.prefix}`,
    components,
    `exclude: ${list(draft.exclude)}`,
    `docs: { glossary: ${scalar(draft.docs.glossary)}, briefs: ${scalar(draft.docs.briefs)} }`,
    'supply_chain:',
    '  allow: {}',
    '  exceptions: {}',
    '',
  ].join('\n');
}

const PREFIX = /^[A-Z][A-Z0-9]{0,5}$/;

/**
 * A prefix from a name, used when none is given: the initials of its words, `LoreLock` → `LL`,
 * `Thea` → `T`. Whether it is free in the organisation is checked where the organisation can be
 * read.
 */
export function derivePrefix(name: string): string {
  const words = name
    .split(/[^A-Za-z0-9]+/)
    .flatMap((word) => word.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter((word) => word !== '');
  const initials = words
    .map((word) => word.charAt(0).toUpperCase())
    .join('')
    .slice(0, 6);
  return PREFIX.test(initials) ? initials : 'P';
}

/**
 * Whether an existing `talos.yml` is only the seed `talos new` writes (a name and a prefix), which
 * adoption completes; any other key means someone set it up, and adoption keeps it.
 */
export function isSeed(text: string): boolean {
  try {
    const parsed: unknown = parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    return Object.keys(parsed).every((key) => key === 'name' || key === 'prefix');
  } catch {
    return false;
  }
}

/**
 * Makes the map at `path`, and each map holding it, a block, created when missing: a map inside
 * a flow map is written as flow too. `false` when one of them isn't a map.
 */
function asBlock(doc: Document, path: readonly string[]): boolean {
  if (!doc.hasIn(path)) doc.setIn(path, doc.createNode({}));
  return path.every((_, index) => {
    const node = doc.getIn(path.slice(0, index + 1), true);
    if (!isMap(node)) return false;
    node.flow = false;
    return true;
  });
}

function addMissing(
  doc: Document,
  path: readonly string[],
  entries: Readonly<Record<string, unknown>>,
): boolean {
  const fresh = Object.entries(entries).filter(([key]) => !doc.hasIn([...path, key]));
  if (fresh.length === 0 || !asBlock(doc, path)) return false;
  for (const [key, value] of fresh) doc.setIn([...path, key], doc.createNode(value));
  return true;
}

/**
 * `talos.yml` with the exceptions and licences a repository's own scanner settings held, each
 * added unless `talos.yml` already has an entry of that name. The rest of the file stays as it is.
 */
export function withAdditions(text: string, additions: Additions): string {
  const doc = parseDocument(text);
  const exceptions = addMissing(doc, ['supply_chain', 'exceptions'], additions.exceptions);
  const licences = addMissing(doc, ['licences'], additions.licences);
  return exceptions || licences ? doc.toString({ lineWidth: 0, singleQuote: true }) : text;
}
