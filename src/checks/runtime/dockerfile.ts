import { type Declaration, type Place, pinned } from './declaration.js';
import type { Runtime } from './runtimes.js';

export type Instruction = {
  /** Upper-case: `FROM`, `ARG`. */
  readonly keyword: string;
  readonly args: string;
  readonly line: number;
  readonly endLine: number;
};

const DIRECTIVE = /^#\s*([a-z]+)\s*=\s*(\S+)\s*$/i;
const HEREDOC_WORD = /^\d*<<-?(["']?)([^<"'\s]+)\1$/;
const HEREDOC_KEYWORDS: ReadonlySet<string> = new Set(['RUN', 'COPY', 'ADD']);

/** The escape character, which a parser directive at the top may change to a backtick. */
function escapeOf(lines: readonly string[]): string {
  for (const line of lines) {
    const directive = DIRECTIVE.exec(line);
    if (directive === null) return '\\';
    if (directive[1]?.toLowerCase() === 'escape') return directive[2] === '`' ? '`' : '\\';
  }
  return '\\';
}

function isSkippable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function toInstruction(parts: readonly string[], line: number, endLine: number): Instruction {
  const joined = parts.join(' ').trim();
  const space = joined.search(/\s/);
  const keyword = space < 0 ? joined : joined.slice(0, space);
  const args = space < 0 ? '' : joined.slice(space + 1).trim();
  return { keyword: keyword.toUpperCase(), args, line, endLine };
}

/**
 * The heredoc delimiters an instruction opens, in order: as BuildKit reads them, only in `RUN`,
 * `COPY` and `ADD`, and only as a whole word (`<<EOF`, `<<-"EOF"`), so a here-string or a shift
 * opens none.
 */
function delimitersOf(instruction: Instruction): string[] {
  if (!HEREDOC_KEYWORDS.has(instruction.keyword)) return [];
  return instruction.args
    .split(/\s+/)
    .map((word) => HEREDOC_WORD.exec(word)?.[2])
    .filter((name): name is string => name !== undefined);
}

type Reading = {
  readonly escape: string;
  readonly found: Instruction[];
  parts: string[];
  start: number;
  delimiters: string[];
};

function readLine(state: Reading, raw: string, line: number): void {
  if (state.delimiters.length > 0) {
    if (raw.replace(/^\t+/, '') === state.delimiters[0]) state.delimiters.shift();
    return;
  }
  if (isSkippable(raw)) return;
  if (state.parts.length === 0) state.start = line;
  const trimmed = raw.trimEnd();
  const continued = trimmed.endsWith(state.escape);
  state.parts.push(continued ? trimmed.slice(0, -1) : trimmed);
  if (continued) return;
  const instruction = toInstruction(state.parts, state.start, line);
  state.found.push(instruction);
  state.delimiters = delimitersOf(instruction);
  state.parts = [];
}

/**
 * The Dockerfile's instructions: continuation lines joined, comments, blank lines and heredoc
 * bodies left out.
 */
export function instructions(text: string): Instruction[] {
  const lines = text.split(/\r?\n/);
  const state: Reading = {
    escape: escapeOf(lines),
    found: [],
    parts: [],
    start: 0,
    delimiters: [],
  };
  for (const [index, raw] of lines.entries()) readLine(state, raw, index + 1);
  if (state.parts.length > 0) {
    state.found.push(toInstruction(state.parts, state.start, lines.length));
  }
  return state.found;
}

type Arg = { readonly value?: string; readonly line: number };

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

function argOf(token: string, line: number): [string, Arg] {
  const equals = token.indexOf('=');
  if (equals < 0) return [token, { line }];
  return [token.slice(0, equals), { value: unquote(token.slice(equals + 1)), line }];
}

/** The build arguments declared before the first `FROM`, the only ones a `FROM` line may use. */
export function globalArgs(list: readonly Instruction[]): Map<string, Arg> {
  const firstFrom = list.findIndex((instruction) => instruction.keyword === 'FROM');
  const prelude = firstFrom < 0 ? list : list.slice(0, firstFrom);
  return new Map(
    prelude
      .filter((instruction) => instruction.keyword === 'ARG')
      .flatMap((instruction) =>
        instruction.args
          .split(/\s+/)
          .filter((token) => token !== '')
          .map((token) => argOf(token, instruction.line)),
      ),
  );
}

const VARIABLE = /\$\{([A-Za-z_]\w*)(?::?([-+])([^}]*))?\}|\$([A-Za-z_]\w*)/g;

export type Substituted = {
  readonly text: string;
  /** The build arguments whose values went into the text. */
  readonly used: readonly string[];
};

function expand(match: RegExpExecArray, args: ReadonlyMap<string, Arg>, used: string[]): string {
  const [whole, braced, operator, word = '', bare] = match;
  const name = braced ?? bare ?? '';
  const value = args.get(name)?.value;
  const set = value !== undefined && value !== '';
  if (set) used.push(name);
  if (operator === '-') return set ? value : word;
  if (operator === '+') return set ? word : '';
  return value ?? whole;
}

/**
 * Replaces `$NAME`, `${NAME}`, `${NAME:-default}` and `${NAME:+alternative}` as Docker does;
 * a variable with no value and no default stays as written.
 */
export function substitute(text: string, args: ReadonlyMap<string, Arg>): Substituted {
  const used: string[] = [];
  let replaced = '';
  let last = 0;
  for (const match of text.matchAll(VARIABLE)) {
    replaced += text.slice(last, match.index) + expand(match, args, used);
    last = match.index + match[0].length;
  }
  return { text: replaced + text.slice(last), used };
}

type Reference = { readonly path: string; readonly tag?: string; readonly digest?: string };

/** `[registry/]path[:tag][@digest]`. */
export function splitReference(reference: string): Reference {
  const at = reference.indexOf('@');
  const named = at < 0 ? reference : reference.slice(0, at);
  const digest = at < 0 ? undefined : reference.slice(at + 1);
  const colon = named.lastIndexOf(':');
  const hasTag = colon > named.lastIndexOf('/');
  return {
    path: hasTag ? named.slice(0, colon) : named,
    ...(hasTag ? { tag: named.slice(colon + 1) } : {}),
    ...(digest === undefined ? {} : { digest }),
  };
}

/** The image's name on Docker Hub: no registry host, no `library/`. */
export function officialName(path: string): string {
  const parts = path.toLowerCase().split('/');
  const [first = '', ...rest] = parts;
  const hosted = rest.length > 0 && (/[.:]/.test(first) || first === 'localhost');
  let name = (hosted ? rest : parts).join('/');
  for (const prefix of ['docker/library/', 'library/']) {
    if (name.startsWith(prefix)) name = name.slice(prefix.length);
  }
  return name;
}

const IMAGES: ReadonlyMap<string, Runtime> = new Map<string, Runtime>([
  ['php', 'php'],
  ['node', 'node'],
  ['python', 'python'],
  ['rust', 'rust'],
  ['golang', 'go'],
  ['ruby', 'ruby'],
  ['oven/bun', 'bun'],
  ['denoland/deno', 'deno'],
]);

/** The release a tag names: its first dash-separated part that starts with a digit. */
export function tagVersion(tag: string): string | undefined {
  return tag.split('-').find((segment) => /^\d/.test(segment));
}

function written(reference: Reference): string {
  const tag = reference.tag === undefined ? '' : `:${reference.tag}`;
  const digest = reference.digest === undefined ? '' : `@${reference.digest.slice(0, 15)}…`;
  return `${reference.path}${tag}${digest}`;
}

type FromLine = { readonly image?: string; readonly stage?: string };

/** `FROM [--platform=…] image [AS stage]`. */
export function parseFrom(args: string): FromLine {
  const tokens = args.split(/\s+/).filter((token) => token !== '' && !token.startsWith('--'));
  const [image, as, stage] = tokens;
  return {
    ...(image === undefined ? {} : { image }),
    ...(as?.toLowerCase() === 'as' && stage !== undefined ? { stage: stage.toLowerCase() } : {}),
  };
}

type Scope = {
  readonly file: string;
  readonly args: ReadonlyMap<string, Arg>;
  readonly stages: ReadonlySet<string>;
};

/** The line that sets the version: the build argument that carries it, else the `FROM` line. */
function placeOf(
  scope: Scope,
  from: Instruction,
  used: readonly string[],
  version?: string,
): Place {
  const carrier =
    version === undefined
      ? undefined
      : used.map((name) => scope.args.get(name)).find((arg) => arg?.value?.includes(version));
  if (carrier !== undefined) return { file: scope.file, line: carrier.line };
  const span = from.endLine > from.line ? { endLine: from.endLine } : {};
  return { file: scope.file, line: from.line, ...span };
}

function fromDeclaration(scope: Scope, from: Instruction): Declaration | undefined {
  const { image } = parseFrom(from.args);
  if (image === undefined || image === 'scratch' || scope.stages.has(image.toLowerCase())) {
    return undefined;
  }
  const resolved = substitute(image, scope.args);
  const reference = splitReference(resolved.text);
  if (reference.path.includes('$')) return undefined;
  const runtime = IMAGES.get(officialName(reference.path));
  if (runtime === undefined) return undefined;
  const tag = reference.tag;
  const version = tag === undefined || tag.includes('$') ? undefined : tagVersion(tag);
  const place = placeOf(scope, from, resolved.used, version);
  return pinned(runtime, place, written(reference), version);
}

/**
 * The runtimes a Dockerfile's `FROM` lines build on, every stage: official images of a runtime
 * (`php`, `node`, `python`, `rust`, `golang`, `ruby`, `oven/bun`, `denoland/deno`) from any
 * registry, build arguments resolved where they have a value.
 */
export function dockerfileDeclarations(file: string, text: string): Declaration[] {
  const list = instructions(text);
  const stages = new Set<string>();
  const scope: Scope = { file, args: globalArgs(list), stages };
  const found: Declaration[] = [];
  for (const instruction of list.filter((i) => i.keyword === 'FROM')) {
    const declaration = fromDeclaration(scope, instruction);
    if (declaration !== undefined) found.push(declaration);
    const { stage } = parseFrom(instruction.args);
    if (stage !== undefined) stages.add(stage);
  }
  return found;
}
