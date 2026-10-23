import {
  blockComment,
  endOfLine,
  lineComment,
  type Matcher,
  previousSignificant,
  quoted,
  type State,
} from './scan.js';

const BEFORE_REGEX = new Set('(,=:[!&|?{};+-*%<>~^');
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
]);

/** Whether a `/` at `offset` starts a regular expression rather than dividing. */
function regexAllowed(text: string, offset: number): boolean {
  const previous = previousSignificant(text, offset);
  if (previous < 0) return true;
  const char = text[previous] ?? '';
  if (BEFORE_REGEX.has(char)) return true;
  let start = previous;
  while (start > 0 && /[\w$]/.test(text[start - 1] ?? '')) start -= 1;
  return REGEX_KEYWORDS.has(text.slice(start, previous + 1));
}

/** The offset after a regular expression literal's flags, or undefined when it isn't one. */
function regexEnd(text: string, from: number): number | undefined {
  let inClass = false;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') return undefined;
    if (char === '\\') index += 1;
    else if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      return index + 1 + (/^[a-z]*/.exec(text.slice(index + 1))?.[0].length ?? 0);
    }
  }
  return undefined;
}

const regexLiteral: Matcher = (state) => {
  const { text, at } = state;
  if (text[at] !== '/' || text[at + 1] === '/' || text[at + 1] === '*') return false;
  if (!regexAllowed(text, at)) return false;
  const end = regexEnd(text, at + 1);
  if (end === undefined) return false;
  state.at = end;
  return true;
};

const jsDoc = (rest: string): boolean => rest.startsWith('*') && !rest.startsWith('**');

/** A template literal; comments inside its `${}` expressions are still comments. */
function template(inner: () => readonly Matcher[]): Matcher {
  const expression = (state: State): void => {
    let depth = 1;
    while (state.at < state.text.length && depth > 0) {
      const char = state.text[state.at];
      if (char === '}' || char === '{') {
        depth += char === '{' ? 1 : -1;
        state.at += 1;
      } else if (!inner().some((matcher) => matcher(state))) state.at += 1;
    }
  };
  return (state) => {
    if (state.text[state.at] !== '`') return false;
    state.at += 1;
    while (state.at < state.text.length) {
      const char = state.text[state.at];
      if (char === '\\') state.at += 2;
      else if (char === '`') {
        state.at += 1;
        return true;
      } else if (state.text.startsWith('${', state.at)) {
        state.at += 2;
        expression(state);
      } else state.at += 1;
    }
    return true;
  };
}

/** TypeScript and JavaScript. */
export const JS: readonly Matcher[] = [
  lineComment('//'),
  blockComment('/*', '*/', { doc: jsDoc }),
  quoted("'", { escape: '\\' }),
  quoted('"', { escape: '\\' }),
  template(() => JS),
  regexLiteral,
];

const rustRawString: Matcher = (state) => {
  const first = state.text[state.at];
  if (first !== 'r' && first !== 'b') return false;
  const match = /^b?r(#*)"/.exec(state.text.slice(state.at, state.at + 260));
  if (match === null || /\w/.test(state.text[state.at - 1] ?? '')) return false;
  const closing = `"${match[1] ?? ''}`;
  const end = state.text.indexOf(closing, state.at + match[0].length);
  state.at = end === -1 ? state.text.length : end + closing.length;
  return true;
};

const CHAR = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'/;

/** A character literal; a lone quote is a lifetime and is skipped as code. */
const rustChar: Matcher = (state) => {
  if (state.text[state.at] !== "'") return false;
  const match = CHAR.exec(state.text.slice(state.at, state.at + 16));
  state.at += match === null ? 1 : match[0].length;
  return true;
};

/** Rust: `///` and `//!` are docs, and block comments nest. */
export const RUST: readonly Matcher[] = [
  lineComment('//', { doc: (rest) => /^[/!](?!\/)/.test(rest), marker: /^[/!]/ }),
  blockComment('/*', '*/', { nested: true, doc: (rest) => /^[*!](?![*/])/.test(rest) }),
  rustRawString,
  quoted('"', { escape: '\\', multiline: true }),
  rustChar,
];

const PHP_OPEN = /<\?(?:php\b|=)?/g;

/** Where PHP code resumes after `from`: past the next opening tag, or the end. */
export function phpResume(text: string, from: number): number {
  PHP_OPEN.lastIndex = from;
  const match = PHP_OPEN.exec(text);
  return match === null ? text.length : match.index + match[0].length;
}

const phpClose: Matcher = (state) => {
  if (!state.text.startsWith('?>', state.at)) return false;
  state.at = phpResume(state.text, state.at + 2);
  return true;
};

/** A line comment ends at the line's end or at `?>`, which leaves PHP. */
function phpLineEnd(state: State, from: number): number {
  const close = state.text.indexOf('?>', from);
  const end = endOfLine(state.text, from);
  return close !== -1 && close < end ? close : end;
}

const heredoc: Matcher = (state) => {
  if (!state.text.startsWith('<<<', state.at)) return false;
  const match = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1\r?\n/.exec(
    state.text.slice(state.at, state.at + 80),
  );
  if (match === null) return false;
  const closing = new RegExp(String.raw`^[ \t]*${match[2] ?? ''}\b`, 'm');
  const bodyStart = state.at + match[0].length;
  const found = closing.exec(state.text.slice(bodyStart));
  state.at = found === null ? state.text.length : bodyStart + found.index + found[0].length;
  return true;
};

/** PHP, inside its tags only; `#[` starts an attribute, not a comment. */
export const PHP: readonly Matcher[] = [
  phpClose,
  lineComment('//', { end: phpLineEnd }),
  lineComment('#', { end: phpLineEnd, when: (state) => state.text[state.at + 1] !== '[' }),
  blockComment('/*', '*/', { doc: jsDoc }),
  heredoc,
  quoted("'", { escape: '\\', multiline: true }),
  quoted('"', { escape: '\\', multiline: true }),
];
