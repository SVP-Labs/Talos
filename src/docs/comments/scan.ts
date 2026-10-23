/** One line of a comment, its markers stripped. */
export type CommentLine = {
  /** 1-based. */
  readonly line: number;
  readonly text: string;
  /** An API docblock: `/** … *\/`, `///`, a Python docstring, a `---` LuaLS annotation. */
  readonly doc: boolean;
  /** Part of a block comment rather than a line comment. */
  readonly block: boolean;
};

/**
 * A lexer's position in a source file. Matchers look at `text` from `at`; one that recognises
 * what starts there consumes it, moving `at`, and says so.
 */
export type State = {
  readonly text: string;
  at: number;
  readonly out: CommentLine[];
  readonly lineStarts: readonly number[];
  /** Here-document delimiters a shell line has opened, read from the next line on. */
  readonly heredocDelimiters: string[];
};

export type Matcher = (state: State) => boolean;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/** The 1-based line of an offset. */
function lineOf(state: State, offset: number): number {
  let low = 0;
  let high = state.lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((state.lineStarts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Runs the matchers over the text, first match wins; anything else is code, skipped. */
export function scan(text: string, matchers: readonly Matcher[], start = 0): CommentLine[] {
  const state: State = {
    text,
    at: start,
    out: [],
    lineStarts: lineStarts(text),
    heredocDelimiters: [],
  };
  while (state.at < text.length) {
    if (!matchers.some((matcher) => matcher(state))) state.at += 1;
  }
  return state.out;
}

export type CommentKind = { readonly doc: boolean; readonly block: boolean };

/** Records a comment's body, which starts at `from`, one entry per line. */
export function emit(state: State, from: number, body: string, kind: CommentKind): void {
  const first = lineOf(state, from);
  for (const [index, raw] of body.split('\n').entries()) {
    const text = kind.block ? raw.replace(/^\s*\*(?!\/)/, '') : raw;
    state.out.push({ line: first + index, text: text.trim(), ...kind });
  }
}

/** The end of the line `from` is on (the offset of its newline, or the text's end). */
export function endOfLine(text: string, from: number): number {
  const newline = text.indexOf('\n', from);
  return newline === -1 ? text.length : newline;
}

/** A comment running to the end of the line, such as `//` or `#`. */
export function lineComment(
  opener: string,
  options: {
    readonly doc?: (rest: string) => boolean;
    readonly when?: (state: State) => boolean;
    readonly end?: (state: State, from: number) => number;
    /** A doc comment's own marker, such as the third `/` of `///`, left out of its text. */
    readonly marker?: RegExp;
  } = {},
): Matcher {
  return (state) => {
    if (!state.text.startsWith(opener, state.at)) return false;
    if (options.when?.(state) === false) return false;
    const from = state.at + opener.length;
    const end = options.end?.(state, from) ?? endOfLine(state.text, from);
    const body = state.text.slice(from, end);
    const doc = options.doc?.(body) ?? false;
    emit(state, from, doc && options.marker ? body.replace(options.marker, '') : body, {
      doc,
      block: false,
    });
    state.at = end;
    return true;
  };
}

function nestedEnd(text: string, from: number, open: string, close: string): number {
  let depth = 1;
  let index = from;
  while (index < text.length && depth > 0) {
    if (text.startsWith(open, index)) {
      depth += 1;
      index += open.length;
    } else if (text.startsWith(close, index)) {
      depth -= 1;
      index += close.length;
    } else index += 1;
  }
  return depth === 0 ? index - close.length : text.length;
}

/** A comment between two markers, such as `/* … *\/`; Rust nests them. */
export function blockComment(
  open: string,
  close: string,
  options: { readonly nested?: boolean; readonly doc?: (rest: string) => boolean } = {},
): Matcher {
  return (state) => {
    if (!state.text.startsWith(open, state.at)) return false;
    const from = state.at + open.length;
    const found =
      options.nested === true
        ? nestedEnd(state.text, from, open, close)
        : state.text.indexOf(close, from);
    const end = found === -1 ? state.text.length : found;
    const body = state.text.slice(from, end);
    emit(state, from, body, { doc: options.doc?.(body) ?? false, block: true });
    state.at = Math.min(state.text.length, end + close.length);
    return true;
  };
}

/** The offset after a string's closing quote, starting just after its opening one. */
export function stringEnd(
  text: string,
  from: number,
  quote: string,
  options: { readonly escape?: string; readonly doubled?: boolean; readonly multiline?: boolean },
): number {
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === options.escape) index += 2;
    else if (text.startsWith(quote, index)) {
      if (options.doubled === true && text.startsWith(quote, index + quote.length)) {
        index += 2 * quote.length;
      } else return index + quote.length;
    } else if (char === '\n' && options.multiline !== true) return index;
    else index += 1;
  }
  return text.length;
}

/** A string literal, skipped so that comment markers inside it are not comments. */
export function quoted(
  quote: string,
  options: { readonly escape?: string; readonly doubled?: boolean; readonly multiline?: boolean },
): Matcher {
  return (state) => {
    if (!state.text.startsWith(quote, state.at)) return false;
    state.at = stringEnd(state.text, state.at + quote.length, quote, options);
    return true;
  };
}

/** The last character before `offset` that isn't white space, and where it is. */
export function previousSignificant(text: string, offset: number): number {
  let index = offset - 1;
  while (index >= 0 && /\s/.test(text[index] ?? '')) index -= 1;
  return index;
}
