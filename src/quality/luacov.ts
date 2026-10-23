/**
 * luacov's statistics file and its rules for which lines count. The statistics hold hit counts
 * only: a `0` pads the lines up to the last one hit and says nothing about whether a line can run.
 * luacov's reporter decides that from the source with its line scanner, ported here from luacov
 * 0.17's `luacov/linescanner.lua` and `luacov/reporter.lua`. With cluacov installed, luacov's
 * reporter also drops lines the compiled code has no instruction for; that needs Lua, so a
 * runner wanting it converts the statistics to LCOV with luacov's reporter instead.
 */

const WHITESPACE = '[ \\t\\n\\v\\f\\r]';

/** luacov names a file as Lua loaded it: `./src/a.lua`, `src\a.lua`, or absolute. */
export function luacovName(name: string): string {
  let path = name.replaceAll('\\', '/');
  while (path.startsWith('./')) path = path.slice(2);
  return path;
}

class StatsReader {
  private position = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  /** Lua's `read("*n")` for the non-negative integers luacov writes: leading whitespace skipped. */
  number(): number | undefined {
    const match = /[ \t\n\v\f\r]*(\d+)/y;
    match.lastIndex = this.position;
    const found = match.exec(this.text);
    if (found?.[1] === undefined) return undefined;
    this.position = match.lastIndex;
    return Number(found[1]);
  }

  /** Reads one character when it is `char`. */
  take(char: string): boolean {
    if (this.text[this.position] !== char) return false;
    this.position += 1;
    return true;
  }

  /** Lua's `read("*l")`: the rest of the line. */
  line(): string {
    const end = this.text.indexOf('\n', this.position);
    const stop = end < 0 ? this.text.length : end;
    const line = this.text.slice(this.position, stop).replace(/\r$/, '');
    this.position = stop + 1;
    return line;
  }
}

function readHits(reader: StatsReader, max: number, into: Map<number, number>): void {
  for (let line = 1; line <= max; line += 1) {
    const hits = reader.number();
    if (hits === undefined || !reader.take(' ')) return;
    if (hits > 0) into.set(line, (into.get(line) ?? 0) + hits);
  }
}

/**
 * `luacov.stats.out`, read as luacov's `stats.load` reads it: for each file a `<max>:<name>`
 * line and then `max` hit counts, each followed by a space. Names that reach one file are merged.
 */
export function parseLuacovStats(text: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  const reader = new StatsReader(text);
  for (;;) {
    const max = reader.number();
    if (max === undefined || !reader.take(':')) break;
    const name = luacovName(reader.line());
    const hits = files.get(name) ?? new Map<number, number>();
    files.set(name, hits);
    readHits(reader, max, hits);
  }
  return files;
}

/** luacov's exclusion patterns, translated from Lua patterns with its fixups applied. */
const ALWAYS = [
  '',
  'end[,; )]*',
  'else',
  'repeat',
  'do',
  'if',
  'then',
  'while t do',
  'if t then',
  'local x',
  'local x ?= ?',
  'local x ?, ?x[x, ]*',
  'local x ?, ?x[x, ]* ?= ?',
  'local function x',
];

const WHEN_NOT_HIT = [
  "[ntfx0',= ]+,",
  '\\{ ?\\} ?,',
  "\\[? ?[ntfx0']+ ?\\]? ?= ?.+[,;]",
  "\\[? ?[ntfx0']+ ?\\]? ?= ?function",
  "\\[? ?[ntfx0']+ ?\\]? ?= ?[ (]*'",
  'return function',
  'function',
  '[ntfx0]',
  "''",
  '\\{ ?\\}',
  "x ?[\\[.]? ?[ntfx0']* ?\\]?",
  'local x ?= ?function',
  "local x ?= ?[ (]*'",
  'local x ?= ? ?\\( ?[ (]*',
  'local x ?, ?x[x, ]* ?= ? ?\\( ?[ (]*',
  'local x ?= ?n',
  "x ?[\\[.]? ?[ntfx0']* ?\\]? ?= ?[ (]*'",
  "x ?[\\[.]? ?[ntfx0']* ?\\]? ?= ?function",
  '\\} ?,',
  '\\} ?, ?function',
  'break',
  '\\{',
  '\\}?[ )]*',
  "[ntf0']+ ?\\}[ )]*",
  'goto [A-Za-z0-9_]+',
  '::[A-Za-z0-9_]+::',
];

function exclusions(patterns: readonly string[]): RegExp {
  return new RegExp(`^ *(?:${patterns.map((pattern) => `(?:${pattern})`).join('|')}) *$`);
}

const ALWAYS_EXCLUDED = exclusions(ALWAYS);
const EXCLUDED_WHEN_NOT_HIT = exclusions(WHEN_NOT_HIT);

const KEYWORDS = new Map<string, string>([
  ['nil', 'n'],
  ['true', 't'],
  ['false', 'f'],
  ...[
    'and',
    'break',
    'do',
    'else',
    'elseif',
    'end',
    'for',
    'function',
    'goto',
    'if',
    'in',
    'local',
    'not',
    'or',
    'repeat',
    'return',
    'then',
    'until',
    'while',
  ].map((keyword): [string, string] => [keyword, keyword]),
]);

const CLOSING = {
  '"': { anchored: /(\\*)\1"/y, anywhere: /[^\\](\\*)\1"/g },
  "'": { anchored: /(\\*)\1'/y, anywhere: /[^\\](\\*)\1'/g },
};

const ENABLE = new RegExp(`^${WHITESPACE}*luacov:${WHITESPACE}*enable${WHITESPACE}*$`);
const DISABLE = new RegExp(`^${WHITESPACE}*luacov:${WHITESPACE}*disable${WHITESPACE}*$`);

/**
 * luacov's line scanner: reduces each line to a skeleton (names `x`, numbers `0`, strings `''`,
 * `nil`/`true`/`false` as `n`/`t`/`f`, function arguments dropped) and matches it against the
 * exclusion patterns. State carries over lines for strings, comments and argument lists.
 */
export class LineScanner {
  private first = true;
  private comment = false;
  private afterFunction = false;
  private enabled = true;
  private quote: '"' | "'" | undefined;
  private equals: string | undefined;
  private args = false;
  private line = '';
  private index = 0;
  private buffer: string[] = [];

  /** Whether the line is always excluded, and whether it is excluded when no test hit it. */
  consume(line: string): readonly [boolean, boolean] {
    if (this.first) {
      this.first = false;
      if (line.startsWith('#!')) return [true, true];
    }
    this.line = line;
    this.index = 0;
    this.buffer = [];
    while (this.index < line.length) {
      if (!this.step()) break;
    }
    if (!this.enabled) return [true, true];
    const skeleton = this.buffer.join('');
    return [ALWAYS_EXCLUDED.test(skeleton), EXCLUDED_WHEN_NOT_HIT.test(skeleton)];
  }

  private at(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = this.index;
    return pattern.exec(this.line);
  }

  /** One token; false when the rest of the line is a comment or continues on the next line. */
  private step(): boolean {
    if (this.quote !== undefined) return this.skipString(this.quote);
    if (this.equals !== undefined) return this.skipLongString(this.equals);
    if (this.args) return this.skipArgs();
    this.skipWhitespace();
    if (this.at(/\.\d/y)) this.index += 1;
    if (this.at(/\d/y)) this.skipNumber();
    else if (this.at(/[A-Za-z_]/y)) this.skipName();
    else return this.punctuation();
    return true;
  }

  private skipString(quote: '"' | "'"): boolean {
    const closing = CLOSING[quote];
    const found = this.at(closing.anchored) ?? this.at(closing.anywhere);
    if (found === null) return false;
    this.index = found.index + found[0].length;
    this.quote = undefined;
    this.buffer.push("'");
    return true;
  }

  private skipLongString(equals: string): boolean {
    const close = `]${equals}]`;
    const end = this.line.indexOf(close, this.index);
    if (end < 0) return false;
    this.index = end + close.length;
    this.equals = undefined;
    if (this.comment) this.comment = false;
    else this.buffer.push("'");
    return true;
  }

  private skipArgs(): boolean {
    const end = this.line.indexOf(')', this.index);
    if (end < 0) return false;
    this.index = end + 1;
    this.args = false;
    return true;
  }

  private skipWhitespace(): void {
    const next = this.at(/[^ \t\n\v\f\r]/g)?.index ?? this.line.length;
    if (next !== this.index) {
      this.index = next;
      this.buffer.push(' ');
    }
  }

  private skipPattern(pattern: RegExp): void {
    this.index += this.at(pattern)?.[0].length ?? 0;
  }

  private skipNumber(): void {
    if (this.at(/0[xX]/y)) this.index += 2;
    this.skipPattern(/[0-9A-Fa-f.]*/y);
    if (this.at(/[eEpP][+-]/y)) {
      this.index += 2;
      this.skipPattern(/[0-9A-Fa-f.]*/y);
    }
    this.skipPattern(/[iul]*/y);
    this.buffer.push('0');
  }

  private skipName(): void {
    const name = this.at(/\w*/y)?.[0] ?? '';
    this.index += name.length;
    const token = KEYWORDS.get(name) ?? 'x';
    this.buffer.push(token);
    if (token === 'function') this.afterFunction = true;
  }

  private punctuation(): boolean {
    if (this.at(/--/y)) {
      this.comment = true;
      this.index += 2;
    }
    const bracket = this.at(/\[(=*)\[/y);
    if (bracket !== null) {
      this.index += bracket[0].length;
      this.equals = bracket[1] ?? '';
      if (!this.comment) this.buffer.push("'");
      return true;
    }
    if (this.comment) {
      this.comment = false;
      this.inlineOptions(this.line.slice(this.index));
      return false;
    }
    this.symbol(this.line.charAt(this.index));
    return true;
  }

  private symbol(char: string): void {
    if (char === '.') {
      const dots = this.at(/\.*/y)?.[0] ?? '.';
      this.index += dots.length;
      this.buffer.push(dots);
      return;
    }
    this.index += 1;
    if (char === '"' || char === "'") {
      this.buffer.push("'");
      this.quote = char;
    } else if (this.afterFunction && char === '(') {
      this.afterFunction = false;
      this.args = true;
    } else {
      this.buffer.push(char);
    }
  }

  private inlineOptions(body: string): void {
    if (ENABLE.test(body)) this.enabled = true;
    else if (DISABLE.test(body)) this.enabled = false;
  }
}

/**
 * The lines luacov's reporter counts, with their hits (0 for a missed line): a line is counted
 * unless the scanner always excludes it, or excludes it when unhit and no test hit it.
 */
export function luacovLines(
  source: string,
  hits: ReadonlyMap<number, number>,
): Map<number, number> {
  const lines = source.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const scanner = new LineScanner();
  const counted = new Map<number, number>();
  for (const [index, line] of lines.entries()) {
    const [always, whenNotHit] = scanner.consume(line);
    const hit = hits.get(index + 1) ?? 0;
    if (!always && (!whenNotHit || hit !== 0)) counted.set(index + 1, hit);
  }
  return counted;
}
