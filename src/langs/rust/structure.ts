import { scanRust, type Token } from './scan.js';

/** Inclusive, 1-based lines. */
export type Span = { readonly start: number; readonly end: number };

export type FileShape = {
  /** Lines holding code: neither blank nor only comments. */
  readonly codeLines: ReadonlySet<number>;
  /** Items only tests compile: `#[cfg(test)]` modules and functions, `#[test]` functions. */
  readonly tests: readonly Span[];
  /** The file opens with `#![cfg(test)]`. */
  readonly wholeFileTest: boolean;
  /** Modules declared here as `#[cfg(test)] mod name;`, which live in files of their own. */
  readonly testModules: readonly string[];
  /** Blocks nested one level deeper than the limit, each spanning its whole block. */
  readonly deep: readonly Span[];
};

export const MAX_DEPTH = 3;

const TEST_ATTRIBUTES = new Set(['test', 'rstest', 'test_case']);

/** The index just past the bracket that closes the one at `open`, or the end. */
function closing(tokens: readonly Token[], open: number): number {
  const pairs: Readonly<Record<string, string>> = { '[': ']', '(': ')', '{': '}' };
  const close = pairs[tokens[open]?.text ?? ''];
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const text = tokens[i]?.text;
    if (text === tokens[open]?.text) depth += 1;
    else if (text === close) depth -= 1;
    if (depth === 0) return i + 1;
  }
  return tokens.length;
}

/** Whether an attribute's tokens (inside its brackets) mark test-only code. */
export function isTestAttribute(inner: readonly Token[]): boolean {
  const words = inner.filter((t) => t.kind === 'ident').map((t) => t.text);
  if (words[0] === 'cfg') return words.includes('test') && !words.includes('not');
  let last = 0;
  while (inner[last + 1]?.text === '::' && inner[last + 2]?.kind === 'ident') last += 2;
  return inner[0]?.kind === 'ident' && TEST_ATTRIBUTES.has(inner[last]?.text ?? '');
}

/** The index just past an item starting at `from`: its `;` or its closing brace. */
function itemEnd(tokens: readonly Token[], from: number): number {
  let i = from;
  while (i < tokens.length) {
    const text = tokens[i]?.text;
    if (text === ';') return i + 1;
    if (text === '{' || text === '(' || text === '[') {
      const after = closing(tokens, i);
      if (text === '{') return after;
      i = after;
    } else i += 1;
  }
  return tokens.length;
}

type Attribute = { readonly start: number; readonly end: number; readonly test: boolean };

function attributeAt(tokens: readonly Token[], i: number): Attribute | undefined {
  if (tokens[i]?.text !== '#') return undefined;
  const bracket = tokens[i + 1]?.text === '!' ? i + 2 : i + 1;
  if (tokens[bracket]?.text !== '[') return undefined;
  const end = closing(tokens, bracket);
  return { start: i, end, test: isTestAttribute(tokens.slice(bracket + 1, end - 1)) };
}

type Tests = { spans: Span[]; modules: string[]; wholeFile: boolean };

type TestItem = { readonly span: Span; readonly next: number; readonly module?: string };

/**
 * The item a test attribute at `i` marks: its span, the index after it, and its name if it is
 * `mod name;`.
 */
function testItem(tokens: readonly Token[], i: number, after: number): TestItem {
  let item = after;
  for (let next = attributeAt(tokens, item); next !== undefined; next = attributeAt(tokens, item)) {
    item = next.end;
  }
  const end = itemEnd(tokens, item);
  const span = { start: tokens[i]?.line ?? 1, end: tokens[end - 1]?.endLine ?? 1 };
  const declared = tokens[item]?.text === 'mod' && tokens[end - 1]?.text === ';';
  const name = declared ? tokens[item + 1]?.text : undefined;
  return name === undefined ? { span, next: end } : { span, next: end, module: name };
}

function findTests(tokens: readonly Token[]): Tests {
  const found: Tests = { spans: [], modules: [], wholeFile: false };
  let i = 0;
  let header = true;
  while (i < tokens.length) {
    const attribute = attributeAt(tokens, i);
    const inner = tokens[i + 1]?.text === '!';
    if (attribute === undefined) {
      header = false;
      i += 1;
    } else if (inner || !attribute.test) {
      found.wholeFile ||= inner && attribute.test && header;
      i = attribute.end;
    } else {
      const item = testItem(tokens, i, attribute.end);
      found.spans.push(item.span);
      if (item.module !== undefined) found.modules.push(item.module);
      i = item.next;
    }
  }
  return found;
}

export function shapeOf(text: string): FileShape {
  const tokens = scanRust(text);
  const codeLines = new Set<number>();
  for (const token of tokens) {
    for (let line = token.line; line <= token.endLine; line += 1) codeLines.add(line);
  }
  const tests = findTests(tokens);
  return {
    codeLines,
    tests: tests.spans,
    wholeFileTest: tests.wholeFile,
    testModules: tests.modules,
    deep: deepBlocks(tokens),
  };
}

type Frame = {
  readonly kind: 'scope' | 'control' | 'other';
  readonly depth: number;
  readonly start: number;
  readonly deep: boolean;
  readonly pending: Pending;
  readonly parens: number;
};

type Pending = 'fn' | 'control' | 'item' | undefined;

const CONTROL = new Set(['if', 'else', 'for', 'while', 'loop', 'match']);
const ITEMS = new Set(['impl', 'mod', 'trait', 'struct', 'enum', 'union']);

type Walk = {
  readonly stack: Frame[];
  readonly deep: Span[];
  pending: Pending;
  pendingLine: number;
  parens: number;
};

function onWord(walk: Walk, token: Token, next: Token | undefined): void {
  if (walk.parens > 0) return;
  if (token.text === 'fn') walk.pending = 'fn';
  else if (ITEMS.has(token.text)) walk.pending = 'item';
  else if (CONTROL.has(token.text) && walk.pending !== 'item' && walk.pending !== 'fn') {
    if (token.text === 'for' && next?.text === '<') return;
    if (walk.pending !== 'control') walk.pendingLine = token.line;
    walk.pending = 'control';
  }
}

function frameKind(walk: Walk, previous: Token | undefined): Frame['kind'] {
  const closure = previous?.text === '|' || previous?.text === '||';
  if (closure || walk.pending === 'fn') return 'scope';
  return walk.pending === 'control' && walk.parens === 0 ? 'control' : 'other';
}

function frameDepth(kind: Frame['kind'], parent: Frame | undefined): number {
  if (kind === 'scope') return 0;
  return (parent?.depth ?? 0) + (kind === 'control' ? 1 : 0);
}

function open(walk: Walk, token: Token, previous: Token | undefined): void {
  const kind = frameKind(walk, previous);
  const depth = frameDepth(kind, walk.stack.at(-1));
  const start = kind === 'control' ? walk.pendingLine : token.line;
  const deep = kind === 'control' && depth === MAX_DEPTH + 1;
  walk.stack.push({ kind, depth, start, deep, pending: walk.pending, parens: walk.parens });
  walk.pending = undefined;
  walk.parens = 0;
}

function close(walk: Walk, token: Token): void {
  const frame = walk.stack.pop();
  if (frame === undefined) return;
  if (frame.deep) walk.deep.push({ start: frame.start, end: token.line });
  walk.parens = frame.parens;
  walk.pending = frame.parens > 0 ? frame.pending : undefined;
}

function onPunct(walk: Walk, token: Token, previous: Token | undefined): void {
  const { text } = token;
  if (text === '(' || text === '[') walk.parens += 1;
  else if (text === ')' || text === ']') walk.parens = Math.max(0, walk.parens - 1);
  else if (text === '{') open(walk, token, previous);
  else if (text === '}') close(walk, token);
  else if (walk.parens === 0 && resets(walk.pending, text)) walk.pending = undefined;
}

/** Where a statement or arm ends, and where a function type turns out to be a variable's. */
function resets(pending: Pending, text: string): boolean {
  return text === ';' || text === '=>' || (text === '=' && pending !== 'control');
}

/**
 * Control blocks (`if`, `else`, `for`, `while`, `loop`, `match`) nested deeper than the limit
 * inside one function or closure, counted as ESLint's max-depth counts them: a function's own
 * body, `impl` and `mod` blocks, match arms and plain blocks add no level, and a closure or
 * nested function starts again from zero.
 */
export function deepBlocks(tokens: readonly Token[]): Span[] {
  const walk: Walk = { stack: [], deep: [], pending: undefined, pendingLine: 1, parens: 0 };
  for (const [index, token] of tokens.entries()) {
    if (token.kind === 'ident') onWord(walk, token, tokens[index + 1]);
    else if (token.kind === 'punct') onPunct(walk, token, tokens[index - 1]);
  }
  return walk.deep.sort((a, b) => a.start - b.start);
}
