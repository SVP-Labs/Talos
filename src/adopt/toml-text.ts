import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';

/**
 * TOML edited as text, so a project's comments and layout survive: the file split into its
 * tables, each with the comment lines directly above its header. Every edit is checked by
 * parsing the result, so a layout this can't follow leaves the file alone.
 */

export type TomlSection = {
  /** The table's dotted name, `undefined` for the keys before the first header. */
  readonly name: string | undefined;
  /** An array of tables (`[[name]]`). */
  readonly array: boolean;
  /** Its lines: comments above the header, the header, the body, and the blank lines after. */
  readonly lines: readonly string[];
  /** For each line, whether it starts outside any multi-line string, array or inline table. */
  readonly top: readonly boolean[];
};

type Scan = { quote: string | undefined; depth: number };

type Header = { readonly name: string; readonly array: boolean };

/** A table header line: `[name]` or `[[name]]`, perhaps with a comment after it. */
export function headerOf(line: string): Header | undefined {
  const text = line.trim();
  if (!text.startsWith('[')) return undefined;
  const array = text.startsWith('[[');
  const close = text.indexOf(array ? ']]' : ']');
  if (close === -1) return undefined;
  const rest = text.slice(close + (array ? 2 : 1)).trim();
  if (rest !== '' && !rest.startsWith('#')) return undefined;
  const name = text
    .slice(array ? 2 : 1, close)
    .split('.')
    .map((part) => part.trim())
    .join('.');
  return name === '' ? undefined : { name, array };
}

function closeQuote(line: string, from: number, quote: string): number {
  for (let at = from; at < line.length; at += 1) {
    if (quote.startsWith('"') && line.charAt(at) === '\\') at += 1;
    else if (line.startsWith(quote, at)) return at + quote.length;
  }
  return -1;
}

function openQuote(line: string, at: number): string | undefined {
  const char = line.charAt(at);
  if (char !== '"' && char !== "'") return undefined;
  return line.startsWith(char.repeat(3), at) ? char.repeat(3) : char;
}

/** Follows one line's strings, comments and brackets; strings never span lines but `"""`. */
function scanLine(scan: Scan, line: string): void {
  let at = 0;
  while (at < line.length) {
    if (scan.quote !== undefined) {
      const end = closeQuote(line, at, scan.quote);
      if (end === -1) return;
      scan.quote = undefined;
      at = end;
      continue;
    }
    const char = line.charAt(at);
    if (char === '#') return;
    const quote = openQuote(line, at);
    if (quote !== undefined) {
      scan.quote = quote;
      at += quote.length;
      continue;
    }
    if (char === '[' || char === '{') scan.depth += 1;
    else if (char === ']' || char === '}') scan.depth -= 1;
    at += 1;
  }
  if (scan.quote?.length === 1) scan.quote = undefined;
}

type Building = { name: string | undefined; array: boolean; lines: string[]; top: boolean[] };

/** How many comment lines end `section`, directly above whatever follows it. */
function trailingComments(section: Building): number {
  let count = 0;
  for (let at = section.lines.length - 1; at >= 0; at -= 1) {
    if (!section.top[at] || !(section.lines[at] ?? '').trimStart().startsWith('#')) break;
    count += 1;
  }
  return count;
}

export function splitToml(text: string): TomlSection[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const scan: Scan = { quote: undefined, depth: 0 };
  const sections: Building[] = [{ name: undefined, array: false, lines: [], top: [] }];
  for (const line of lines) {
    const top = scan.quote === undefined && scan.depth === 0;
    const header = top ? headerOf(line) : undefined;
    const current = sections.at(-1) ?? { name: undefined, array: false, lines: [], top: [] };
    if (header === undefined) {
      current.lines.push(line);
      current.top.push(top);
      scanLine(scan, line);
      continue;
    }
    const keep = current.lines.length - trailingComments(current);
    sections.push({
      name: header.name,
      array: header.array,
      lines: [...current.lines.slice(keep), line],
      top: [...current.top.slice(keep), true],
    });
    current.lines.length = keep;
    current.top.length = keep;
  }
  return sections;
}

export function joinToml(sections: readonly TomlSection[], eol = '\n'): string {
  const lines = sections.flatMap((section) => section.lines);
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
  return lines.length === 0 ? '' : `${lines.join(eol)}${eol}`;
}

/** The sections with a blank line after each that has lines, but the last. */
export function spaced(sections: readonly TomlSection[]): TomlSection[] {
  const filled = sections.filter((section) => section.lines.length > 0);
  return filled.map((section, index) => {
    const last = section.lines.at(-1) ?? '';
    if (index === filled.length - 1 || last.trim() === '') return section;
    return { ...section, lines: [...section.lines, ''], top: [...section.top, true] };
  });
}

export function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Whether `name` is `table` or one of its sub-tables. */
export function within(name: string | undefined, table: string): boolean {
  return name !== undefined && (name === table || name.startsWith(`${table}.`));
}

/** The index of the line holding `key = …` at the top of a section's body, or -1. */
export function keyLine(section: TomlSection, key: string): number {
  return section.lines.findIndex((line, index) => {
    const text = line.trimStart();
    return (
      section.top[index] === true &&
      text.startsWith(key) &&
      text.slice(key.length).trimStart().startsWith('=')
    );
  });
}

/** The index just after a section's last line that isn't blank. */
export function bodyEnd(section: TomlSection): number {
  let end = section.lines.length;
  while (end > 0 && (section.lines[end - 1] ?? '').trim() === '') end -= 1;
  return end;
}

/** A section with `lines` put in at `index`. */
export function insertLines(
  section: TomlSection,
  index: number,
  lines: readonly string[],
): TomlSection {
  return {
    ...section,
    lines: [...section.lines.slice(0, index), ...lines, ...section.lines.slice(index)],
    top: [...section.top.slice(0, index), ...lines.map(() => true), ...section.top.slice(index)],
  };
}

/** A section with the line at `index` replaced by `line`. */
export function replaceLine(section: TomlSection, index: number, line: string): TomlSection {
  return { ...section, lines: section.lines.map((old, at) => (at === index ? line : old)) };
}

/** Parsed TOML, or `undefined` when the text isn't TOML. */
export function parsedToml(text: string): Record<string, unknown> | undefined {
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}

/** Values as plain data: smol-toml's tables have no prototype, and its dates are objects. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
}

/** Whether two parsed documents hold the same values. */
export function sameToml(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(plain(a), plain(b));
}
