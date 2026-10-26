/**
 * Text read from data (a key, a word, a repository's name, a here-document's label) found by
 * comparing strings, so no regular expression is ever built from it: every pattern stays fixed
 * in the code, and what it captures is compared with the data.
 */

/** Sticky, zero-width tests (assertions alone) that a match's start and end must pass. */
export type Edges = { readonly start: RegExp; readonly end: RegExp };

function passes(edge: RegExp, text: string, at: number): boolean {
  edge.lastIndex = at;
  return edge.test(text);
}

/** How many code units the character at `at` takes. */
function width(text: string, at: number): number {
  return (text.codePointAt(at) ?? 0) > 0xff_ff ? 2 : 1;
}

/** Whether two characters differ in case alone, as a case-insensitive pattern reads them. */
function sameLetter(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase() || a.toUpperCase() === b.toUpperCase();
}

/** Where `needle` ends when read at `at`, character by character, or -1 when it isn't there. */
function endOf(text: string, needle: string, at: number, ignoreCase: boolean): number {
  if (!ignoreCase) return text.startsWith(needle, at) ? at + needle.length : -1;
  let end = at;
  for (const wanted of needle) {
    const code = text.codePointAt(end);
    if (code === undefined) return -1;
    const found = String.fromCodePoint(code);
    if (found !== wanted && !sameLetter(found, wanted)) return -1;
    end += found.length;
  }
  return end;
}

/** The first place from `from` on where `needle` may start, or -1. */
function candidate(text: string, needle: string, from: number, ignoreCase: boolean): number {
  if (!ignoreCase) return text.indexOf(needle, from);
  return from < text.length ? from : -1;
}

/**
 * Where `needle` occurs in `text` between edges that pass, left to right and without overlap.
 * With `ignoreCase`, each character matches its other case too, as a pattern's `iu` flags read it.
 */
export function literalMatches(
  text: string,
  needle: string,
  edges: Edges,
  ignoreCase = false,
): number[] {
  const found: number[] = [];
  let at = needle === '' ? -1 : candidate(text, needle, 0, ignoreCase);
  while (at !== -1) {
    const end = endOf(text, needle, at, ignoreCase);
    const hit = end !== -1 && passes(edges.start, text, at) && passes(edges.end, text, end);
    if (hit) found.push(at);
    at = candidate(text, needle, hit ? end : at + width(text, at), ignoreCase);
  }
  return found;
}

function isQuote(char: string): boolean {
  return char === '"' || char === "'";
}

/**
 * Whether `line` sets `key`: past its indentation the key, bare or quoted, then `separator`
 * (TOML's `=`, YAML's `:`), with whitespace allowed before it.
 */
export function setsKey(line: string, key: string, separator: string): boolean {
  const text = line.trimStart();
  const start = isQuote(text.charAt(0)) && text.startsWith(key, 1) ? 1 : 0;
  if (!text.startsWith(key, start)) return false;
  const rest = text.slice(start + key.length);
  return (isQuote(rest.charAt(0)) ? rest.slice(1) : rest).trimStart().startsWith(separator);
}

/**
 * The first match of `pattern`, a global regular expression whose first group captures a name,
 * from `from` on whose name is `name`.
 */
export function matchNaming(
  pattern: RegExp,
  text: string,
  from: number,
  name: string,
): RegExpExecArray | undefined {
  pattern.lastIndex = from;
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    if (found[1] === name) return found;
    if (found[0] === '') pattern.lastIndex += 1;
  }
  return undefined;
}
