import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { lowers, type Rustflags, splitLintFlags } from './cargo-config.js';
import { BASE_LINTS, isLevel, type Level, weakerThan } from './lints.js';
import type { Finding } from '../../core/finding.js';

type Table = Readonly<Record<string, unknown>>;

function isTable(value: unknown): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function tableAt(root: unknown, path: readonly string[]): Table | undefined {
  let value: unknown = root;
  for (const key of path) value = isTable(value) ? value[key] : undefined;
  return isTable(value) ? value : undefined;
}

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** The 1-based line that sets `key` (after `header`, when given), else the header's, else 1. */
export function lineOf(text: string, key: string, header?: string): number {
  const lines = text.split(/\r?\n/);
  const start =
    header === undefined
      ? 0
      : Math.max(
          0,
          lines.findIndex((l) => l.trim() === header),
        );
  const pattern = new RegExp(String.raw`^\s*["']?${escape(key)}["']?\s*=`);
  const index = lines.findIndex((line, i) => i >= start && pattern.test(line));
  if (index >= 0) return index + 1;
  return header === undefined || start === 0 ? 1 : start + 1;
}

const weaker = (file: string, line: number, key: string, message: string): Finding => ({
  rule: 'config/weaker',
  message,
  location: { file, line },
  key: `${file} ${key}`,
});

export type Source = { readonly file: string; readonly text: string };

/**
 * A rustfmt or Clippy file the gate ignores: each setting that differs from the base (Talos's
 * file, over the tool's defaults) makes the editor disagree with the gate.
 */
export function shadowingFindings(
  source: Source,
  settings: Table,
  base: Table,
  tool: 'rustfmt' | 'clippy',
): Finding[] {
  const { file, text } = source;
  return Object.entries(settings)
    .filter(([key, value]) => !isDeepStrictEqual(value, base[key]))
    .map(([key, value]) =>
      weaker(
        file,
        lineOf(text, key),
        `${tool} ${key}`,
        `${file} sets ${key} = ${JSON.stringify(value)}, which the gate's ${tool} doesn't: ` +
          'the editor and the gate disagree.',
      ),
    );
}

function levelOf(entry: unknown): Level | undefined {
  if (isLevel(entry)) return entry;
  const level = isTable(entry) ? entry.level : undefined;
  return isLevel(level) ? level : undefined;
}

function entries(table: Table, tool: string): [string, unknown][] {
  return Object.entries(tableAt(table, [tool]) ?? {}).map(([name, entry]) => [
    name.replaceAll('-', '_'),
    entry,
  ]);
}

type Prefix = 'lints' | 'workspace.lints';

/** Each level the base sets that the table leaves out or sets lower. */
function missingLevels(source: Source, prefix: Prefix, table: Table): Finding[] {
  return BASE_LINTS.flatMap((lint): Finding[] => {
    const level = levelOf(new Map(entries(table, lint.tool)).get(lint.name));
    if (level !== undefined && !weakerThan(level, lint.level)) return [];
    const name = lint.tool === 'clippy' ? `clippy::${lint.name}` : lint.name;
    const how = level === undefined ? `doesn't set ${name}` : `sets ${name} to ${level}`;
    const line = lineOf(source.text, lint.name, `[${prefix}.${lint.tool}]`);
    const key = `${prefix}.${lint.tool}.${lint.name}`;
    return [
      weaker(source.file, line, key, `${source.file} ${how}; Talos holds it at ${lint.level}.`),
    ];
  });
}

/** Each other lint the table allows: a suppression for the whole crate. */
function allowed(source: Source, prefix: Prefix, table: Table): Finding[] {
  const based = new Set(BASE_LINTS.map((lint) => `${lint.tool}.${lint.name}`));
  return ['rust', 'clippy'].flatMap((tool) =>
    entries(table, tool)
      .filter(([name, entry]) => !based.has(`${tool}.${name}`) && levelOf(entry) === 'allow')
      .map(([name]) => {
        const qualified = tool === 'clippy' ? `clippy::${name}` : name;
        const line = lineOf(source.text, name, `[${prefix}.${tool}]`);
        const message = `${source.file} allows ${qualified}, which the gate reports.`;
        return weaker(source.file, line, `${prefix}.${tool}.${name}`, message);
      }),
  );
}

/**
 * A `[lints]` or `[workspace.lints]` table against Talos's levels: a level the base sets that is
 * missing or lower, and any lint allowed, which is a suppression for the whole crate.
 */
export function lintTableFindings(
  source: Source,
  prefix: Prefix,
  table: Table | undefined,
): Finding[] {
  if (table === undefined) {
    const message =
      `${source.file} has no [${prefix}] table with Talos's lint levels, ` +
      "so the editor doesn't show what the gate reports.";
    return [weaker(source.file, 1, prefix, message)];
  }
  return [...missingLevels(source, prefix, table), ...allowed(source, prefix, table)];
}

/** Lint flags in `rustflags` that lower what rustc reports (the gate drops them). */
export function rustflagFindings(
  settings: readonly Rustflags[],
  texts: ReadonlyMap<string, string>,
): Finding[] {
  return settings.flatMap((setting) =>
    splitLintFlags(setting.flags)
      .lint.filter(lowers)
      .map((flag) =>
        weaker(
          setting.file,
          lineOf(texts.get(setting.file) ?? '', 'rustflags'),
          `${setting.key} ${flag}`,
          `${setting.file} passes ${flag} to rustc in ${setting.key}, which lowers lint levels.`,
        ),
      ),
  );
}

const LIST = z.array(z.unknown()).catch([]);

/** cargo-machete's ignore lists: dependencies it is told never to report. */
export function macheteFindings(source: Source, manifest: unknown): Finding[] {
  const { file, text } = source;
  const lists = [['package'], ['workspace']].map(
    (path) => tableAt(manifest, [...path, 'metadata', 'cargo-machete'])?.ignored,
  );
  return lists.flatMap((list) =>
    LIST.parse(list)
      .filter((name): name is string => typeof name === 'string')
      .map((name) =>
        weaker(
          file,
          lineOf(text, 'ignored'),
          `cargo-machete ignored ${name}`,
          `${file} tells cargo-machete to ignore ${name}; an unused dependency should go.`,
        ),
      ),
  );
}
