import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

/**
 * Pins the language tools a project's editor also uses at the versions Talos runs, in the
 * project's own dev dependencies, so the editor and the gate agree. Each function returns the
 * manifest's new text, or `undefined` when every pin is already there.
 */

type Pins = Readonly<Record<string, string>>;

/** A JSON manifest's top-level object. */
export type Manifest = Readonly<Record<string, unknown>>;

const record = z.record(z.string(), z.unknown());
const versions = z.record(z.string(), z.string());

function indentOf(text: string): string {
  return /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
}

function sorted(entries: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

/** A manifest's object, or `undefined` when the text isn't a JSON object. */
export function parseManifest(text: string): Manifest | undefined {
  try {
    const parsed = record.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The manifest written back the way the file was: its indent, a newline at the end. */
export function manifestText(manifest: Manifest, like: string): string {
  return `${JSON.stringify(manifest, null, indentOf(like))}\n`;
}

/** Fields of a manifest: where its dev tools and its runtime dependencies are listed. */
export type ManifestFields = { readonly dev: string; readonly runtime: string };

/**
 * `package.json` (`devDependencies`) or `composer.json` (`require-dev`) with the pins in it. A
 * tool the project lists among its runtime dependencies is pinned where it is. The manifest
 * comes back as it was when every pin is there.
 */
export function pinManifest(manifest: Manifest, fields: ManifestFields, pins: Pins): Manifest {
  const dev = versions.catch({}).parse(manifest[fields.dev] ?? {});
  const runtime = versions.catch({}).parse(manifest[fields.runtime] ?? {});
  const nextDev = { ...dev };
  const nextRuntime = { ...runtime };
  let changed = false;
  for (const [name, version] of Object.entries(pins)) {
    const target = name in runtime ? nextRuntime : nextDev;
    if (target[name] === version) continue;
    target[name] = version;
    changed = true;
  }
  if (!changed) return manifest;
  return {
    ...manifest,
    ...(fields.runtime in manifest ? { [fields.runtime]: nextRuntime } : {}),
    [fields.dev]: sorted(nextDev),
  };
}

/** {@link pinManifest} on a manifest's text; `undefined` when every pin is already there. */
export function pinJsonManifest(
  text: string,
  fields: ManifestFields,
  pins: Pins,
): string | undefined {
  const manifest = parseManifest(text);
  if (manifest === undefined) return undefined;
  const pinned = pinManifest(manifest, fields, pins);
  return pinned === manifest ? undefined : manifestText(pinned, text);
}

/** A requirement's name, normalised the way pip compares names. */
export function requirementName(requirement: string): string | undefined {
  const name = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)?.[1];
  return name?.toLowerCase().replaceAll(/[-_.]+/g, '-');
}

/** The requirements with Talos's pins in place of any entry for the same tool. */
export function mergeRequirements(current: readonly string[], pins: Pins): string[] {
  const pinned = new Set(Object.keys(pins).map((name) => requirementName(name)));
  const kept = current.filter((entry) => !pinned.has(requirementName(entry)));
  const wanted = Object.entries(pins).map(([name, version]) => `${name}==${version}`);
  return [...kept, ...wanted];
}

const pyprojectSchema = z.looseObject({
  'dependency-groups': z.looseObject({ dev: z.array(z.string()).optional() }).optional(),
});

type Scan = { depth: number; quote: string | undefined; comment: boolean; escaped: boolean };

function inString(scan: Scan, char: string): void {
  if (scan.escaped) scan.escaped = false;
  else if (char === '\\' && scan.quote === '"') scan.escaped = true;
  else if (char === scan.quote) scan.quote = undefined;
}

/** One character of a TOML array: strings and comments may hold brackets that don't count. */
function step(scan: Scan, char: string): void {
  if (scan.comment) {
    scan.comment = char !== '\n';
    return;
  }
  if (scan.quote !== undefined) {
    inString(scan, char);
    return;
  }
  if (char === '"' || char === "'") scan.quote = char;
  else if (char === '#') scan.comment = true;
  else if (char === '[') scan.depth += 1;
  else if (char === ']') scan.depth -= 1;
}

/** Where a TOML array that starts at `open` (its `[`) ends, just after its `]`; -1 if never. */
export function arrayEnd(text: string, open: number): number {
  const scan: Scan = { depth: 0, quote: undefined, comment: false, escaped: false };
  for (let at = open; at < text.length; at += 1) {
    step(scan, text.charAt(at));
    if (scan.depth === 0) return at + 1;
  }
  return -1;
}

function devArray(entries: readonly string[]): string {
  const lines = entries.map((entry) => `    ${JSON.stringify(entry)},`);
  return ['dev = [', ...lines, ']'].join('\n');
}

function replaceDev(text: string, entries: readonly string[]): string | undefined {
  const header = /^\[dependency-groups\][ \t]*$/m.exec(text);
  if (header === null) {
    const separator = text.endsWith('\n') ? '\n' : '\n\n';
    return `${text}${separator}[dependency-groups]\n${devArray(entries)}\n`;
  }
  const start = header.index + header[0].length;
  const nextTable = /^\[/m.exec(text.slice(start));
  const end = nextTable === null ? text.length : start + nextTable.index;
  const key = /^dev[ \t]*=[ \t]*\[/m.exec(text.slice(start, end));
  if (key === null) return `${text.slice(0, start)}\n${devArray(entries)}${text.slice(start)}`;
  const from = start + key.index;
  const close = arrayEnd(text, from + key[0].length - 1);
  return close === -1
    ? undefined
    : `${text.slice(0, from)}${devArray(entries)}${text.slice(close)}`;
}

export type PythonProjectPin =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'changed'; readonly text: string }
  | { readonly kind: 'manual'; readonly reason: string };

/**
 * `pyproject.toml`: the pins go in the `dev` dependency group, which `uv sync --all-groups`
 * installs. The file is edited as text so its comments and layout stay; a group written in a
 * form this can't edit safely is left for a person.
 */
function devGroup(text: string): string[] | undefined {
  try {
    const parsed = pyprojectSchema.safeParse(parseToml(text));
    return parsed.success ? (parsed.data['dependency-groups']?.dev ?? []) : undefined;
  } catch {
    return undefined;
  }
}

function sameEntries(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

export function pinPythonProject(text: string, pins: Pins): PythonProjectPin {
  const current = devGroup(text);
  if (current === undefined) {
    return { kind: 'manual', reason: 'pyproject.toml has an unusual layout' };
  }
  const wanted = mergeRequirements(current, pins);
  if (wanted.every((entry) => current.includes(entry)) && wanted.length === current.length) {
    return { kind: 'unchanged' };
  }
  const next = replaceDev(text, wanted);
  const written = next === undefined ? undefined : devGroup(next);
  if (next === undefined || written === undefined || !sameEntries(written, wanted)) {
    return { kind: 'manual', reason: 'its [dependency-groups] could not be edited safely' };
  }
  return { kind: 'changed', text: next };
}

/**
 * `requirements-dev.in` for a project without `pyproject.toml`: compiled with hashes after. Its
 * comments and blank lines stay; the pins go at the end.
 */
export function pinRequirementsIn(text: string | undefined, pins: Pins): string | undefined {
  const lines = (text ?? '').split(/\r?\n/);
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
  const wanted = mergeRequirements(lines, pins);
  if (text !== undefined && sameEntries(wanted, lines)) return undefined;
  return `${wanted.join('\n')}\n`;
}
