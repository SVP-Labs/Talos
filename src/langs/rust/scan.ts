/**
 * A Rust tokenizer just deep enough to find items, blocks and lines of code: it skips
 * comments, reads every kind of string, character and lifetime, and keeps the punctuation that
 * shapes the code. It never fails; text it doesn't understand becomes punctuation.
 */

type TokenKind = 'ident' | 'punct' | 'literal' | 'lifetime';

export type Token = {
  readonly kind: TokenKind;
  readonly text: string;
  /** 1-based; a literal spanning lines ends on `endLine`. */
  readonly line: number;
  readonly endLine: number;
};

type Cursor = {
  readonly text: string;
  pos: number;
  line: number;
  readonly tokens: Token[];
};

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;
const TWO_CHAR = new Set(['=>', '->', '::', '||', '&&', '..']);
const RAW_PREFIXES = new Set(['r', 'br', 'cr']);
const STRING_PREFIXES = new Set(['b', 'c']);

function push(c: Cursor, kind: TokenKind, start: number, startLine: number): void {
  c.tokens.push({ kind, text: c.text.slice(start, c.pos), line: startLine, endLine: c.line });
}

function countLines(c: Cursor, from: number, to: number): void {
  for (let i = from; i < to; i += 1) if (c.text[i] === '\n') c.line += 1;
}

function skipLineComment(c: Cursor): void {
  const end = c.text.indexOf('\n', c.pos);
  c.pos = end < 0 ? c.text.length : end;
}

function skipBlockComment(c: Cursor): void {
  let depth = 0;
  while (c.pos < c.text.length) {
    const pair = c.text.slice(c.pos, c.pos + 2);
    if (pair === '/*') depth += 1;
    else if (pair === '*/') depth -= 1;
    if (pair === '/*' || pair === '*/') c.pos += 2;
    else {
      if (c.text[c.pos] === '\n') c.line += 1;
      c.pos += 1;
    }
    if (depth === 0) return;
  }
}

/** A quoted string from its opening quote at `c.pos`; `start` includes any prefix. */
function readString(c: Cursor, start: number, startLine: number): void {
  let i = c.pos + 1;
  while (i < c.text.length && c.text[i] !== '"') i += c.text[i] === '\\' ? 2 : 1;
  countLines(c, c.pos, i);
  c.pos = Math.min(i + 1, c.text.length);
  push(c, 'literal', start, startLine);
}

/** A raw string from its first `#` or quote at `c.pos`. */
function readRawString(c: Cursor, start: number, startLine: number): void {
  let hashes = 0;
  while (c.text[c.pos + hashes] === '#') hashes += 1;
  const open = c.pos + hashes + 1;
  const close = c.text.indexOf(`"${'#'.repeat(hashes)}`, open);
  const end = close < 0 ? c.text.length : close + 1 + hashes;
  countLines(c, c.pos, end);
  c.pos = end;
  push(c, 'literal', start, startLine);
}

function skipWhile(c: Cursor, pattern: RegExp): void {
  while (c.pos < c.text.length && pattern.test(c.text[c.pos] ?? '')) c.pos += 1;
}

/** Whether the quote at `pos` opens a one-character literal such as `'a'` or `'é'`. */
function isCharLiteral(text: string, pos: number): boolean {
  const next = text[pos + 1] ?? '';
  const width = (text.codePointAt(pos + 1) ?? 0) > 0xff_ff ? 2 : 1;
  return next !== '' && next !== '\n' && text[pos + 1 + width] === "'";
}

/** A character literal, byte literal or lifetime from the quote at `c.pos`. */
function readQuote(c: Cursor, start: number): void {
  const { text } = c;
  if (text[c.pos + 1] === '\\') {
    let i = c.pos + 3;
    while (i < text.length && text[i] !== "'" && text[i] !== '\n') i += 1;
    c.pos = Math.min(i + 1, text.length);
    push(c, 'literal', start, c.line);
  } else if (isCharLiteral(text, c.pos)) {
    c.pos += (text.codePointAt(c.pos + 1) ?? 0) > 0xff_ff ? 4 : 3;
    push(c, 'literal', start, c.line);
  } else {
    c.pos += 1;
    skipWhile(c, IDENT_PART);
    push(c, 'lifetime', start, c.line);
  }
}

function isRawStringStart(text: string, pos: number): boolean {
  let i = pos;
  while (text[i] === '#') i += 1;
  return text[i] === '"';
}

/** Reads what a word that prefixes a literal starts (`r"…"`, `b'…'`, `r#ident`); false if none. */
function readPrefixed(c: Cursor, word: string, start: number): boolean {
  const next = c.text[c.pos];
  if (RAW_PREFIXES.has(word) && isRawStringStart(c.text, c.pos)) readRawString(c, start, c.line);
  else if (STRING_PREFIXES.has(word) && next === '"') readString(c, start, c.line);
  else if (word === 'b' && next === "'") readQuote(c, start);
  else if (word === 'r' && next === '#') {
    c.pos += 1;
    const name = c.pos;
    skipWhile(c, IDENT_PART);
    c.tokens.push({
      kind: 'ident',
      text: c.text.slice(name, c.pos),
      line: c.line,
      endLine: c.line,
    });
  } else return false;
  return true;
}

function readIdent(c: Cursor): void {
  const start = c.pos;
  skipWhile(c, IDENT_PART);
  if (!readPrefixed(c, c.text.slice(start, c.pos), start)) push(c, 'ident', start, c.line);
}

function readNumber(c: Cursor): void {
  const start = c.pos;
  skipWhile(c, /\w/);
  if (c.text[c.pos] === '.' && /\d/.test(c.text[c.pos + 1] ?? '')) {
    c.pos += 1;
    skipWhile(c, /\w/);
  }
  push(c, 'literal', start, c.line);
}

function readPunct(c: Cursor): void {
  const start = c.pos;
  c.pos += TWO_CHAR.has(c.text.slice(c.pos, c.pos + 2)) ? 2 : 1;
  push(c, 'punct', start, c.line);
}

function step(c: Cursor): void {
  const ch = c.text[c.pos] ?? '';
  const pair = c.text.slice(c.pos, c.pos + 2);
  if (ch === '\n') {
    c.line += 1;
    c.pos += 1;
  } else if (/\s/.test(ch)) c.pos += 1;
  else if (pair === '//') skipLineComment(c);
  else if (pair === '/*') skipBlockComment(c);
  else if (ch === '"') readString(c, c.pos, c.line);
  else if (ch === "'") readQuote(c, c.pos);
  else if (IDENT_START.test(ch)) readIdent(c);
  else if (/\d/.test(ch)) readNumber(c);
  else readPunct(c);
}

export function scanRust(text: string): Token[] {
  const cursor: Cursor = { text, pos: 0, line: 1, tokens: [] };
  while (cursor.pos < text.length) step(cursor);
  return cursor.tokens;
}
