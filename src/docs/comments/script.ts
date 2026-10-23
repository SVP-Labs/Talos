import {
  blockComment,
  emit,
  endOfLine,
  lineComment,
  type Matcher,
  quoted,
  type State,
  stringEnd,
} from './scan.js';
import { matchNaming } from '../../core/literal.js';

/**
 * A Python string. A triple-quoted one that starts a statement is a docstring, an API
 * docblock, so its lines are reported as doc comments.
 */
const pythonString: Matcher = (state) => {
  const { text, at } = state;
  const quote = text[at];
  if (quote !== '"' && quote !== "'") return false;
  const triple = text.startsWith(quote.repeat(3), at);
  if (!triple) {
    state.at = stringEnd(text, at + 1, quote, { escape: '\\' });
    return true;
  }
  const delimiter = quote.repeat(3);
  const end = stringEnd(text, at + 3, delimiter, { escape: '\\', multiline: true });
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  if (/^\s*[rRbBuUfF]{0,2}$/.test(text.slice(lineStart, at))) {
    const body = text.slice(at + 3, Math.max(at + 3, end - 3));
    emit(state, at + 3, body, { doc: true, block: true });
  }
  state.at = end;
  return true;
};

/** Python: `#` comments and docstrings. */
export const PYTHON: readonly Matcher[] = [lineComment('#'), pythonString];

const LONG_OPEN = /^\[(=*)\[/;

/** A Lua long bracket opening at `from`: where its body starts and ends, and where it closes. */
function longBracket(
  text: string,
  from: number,
): { body: number; bodyEnd: number; end: number } | undefined {
  const open = LONG_OPEN.exec(text.slice(from, from + 64));
  if (open === null) return undefined;
  const close = `]${open[1] ?? ''}]`;
  const body = from + open[0].length;
  const found = text.indexOf(close, body);
  if (found === -1) return { body, bodyEnd: text.length, end: text.length };
  return { body, bodyEnd: found, end: found + close.length };
}

const luaComment: Matcher = (state) => {
  if (!state.text.startsWith('--', state.at)) return false;
  const long = longBracket(state.text, state.at + 2);
  if (long === undefined) {
    return lineComment('--', { doc: (rest) => rest.startsWith('-'), marker: /^-/ })(state);
  }
  emit(state, long.body, state.text.slice(long.body, long.bodyEnd), { doc: false, block: true });
  state.at = long.end;
  return true;
};

const luaLongString: Matcher = (state) => {
  if (state.text[state.at] !== '[') return false;
  const long = longBracket(state.text, state.at);
  if (long === undefined) return false;
  state.at = long.end;
  return true;
};

/** Lua: `--` comments, `--[[ ]]` blocks, and long strings that may hold `--`. */
export const LUA: readonly Matcher[] = [
  luaComment,
  luaLongString,
  quoted("'", { escape: '\\' }),
  quoted('"', { escape: '\\' }),
];

const shebang: Matcher = (state) => {
  if (state.at !== 0 || !state.text.startsWith('#!')) return false;
  state.at = endOfLine(state.text, 0);
  return true;
};

/** A `#` starts a shell comment only at a word's start; `$#` and `${#x}` are code. */
function shellCommentStart(state: State): boolean {
  const before = state.text[state.at - 1];
  return before === undefined || /[\s;&|(]/.test(before);
}

/** `<<EOF`, `<<-EOF` and `<<'EOF'`: the body starts on the next line. */
const heredocOpen: Matcher = (state) => {
  if (!state.text.startsWith('<<', state.at) || state.text[state.at + 2] === '<') return false;
  const match = /^<<-?[ \t]*(["']?)([A-Za-z_]\w*)\1/.exec(
    state.text.slice(state.at, state.at + 80),
  );
  if (match === null) return false;
  state.heredocDelimiters.push(match[2] ?? '');
  state.at += match[0].length;
  return true;
};

/** A line that may close a here-document: its delimiter alone, after tabs. */
const HEREDOC_CLOSE = /^\t*([A-Za-z_]\w*)[ \t]*$/gm;

/** At a line's end with here-documents open, skips their bodies. */
const heredocBodies: Matcher = (state) => {
  if (state.text[state.at] !== '\n' || state.heredocDelimiters.length === 0) return false;
  let at = state.at + 1;
  for (const delimiter of state.heredocDelimiters.splice(0)) {
    const found = matchNaming(HEREDOC_CLOSE, state.text, at, delimiter);
    at = found === undefined ? state.text.length : found.index + found[0].length;
  }
  state.at = at;
  return true;
};

/** Shell scripts. */
export const SHELL: readonly Matcher[] = [
  shebang,
  heredocBodies,
  lineComment('#', { when: shellCommentStart }),
  heredocOpen,
  quoted("'", { multiline: true }),
  quoted('"', { escape: '\\', multiline: true }),
];

/** `@"` … `"@` and `@'` … `'@`, whose closing marker starts a line. */
function hereString(quote: string): Matcher {
  return (state) => {
    if (!state.text.startsWith(`@${quote}`, state.at)) return false;
    if (state.text.slice(state.at + 2, endOfLine(state.text, state.at)).trim() !== '') return false;
    const close = state.text.indexOf(`\n${quote}@`, state.at);
    state.at = close === -1 ? state.text.length : close + 3;
    return true;
  };
}

/** PowerShell: `#` comments and `<# #>` blocks, which carry comment-based help. */
export const POWERSHELL: readonly Matcher[] = [
  blockComment('<#', '#>', { doc: (rest) => /^\s*\.[A-Z]/.test(rest) }),
  lineComment('#'),
  hereString('"'),
  hereString("'"),
  quoted("'", { doubled: true, multiline: true }),
  quoted('"', { escape: '`', multiline: true }),
];
