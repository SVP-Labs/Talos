import { posix } from 'node:path';
import { maskCode, position } from './markdown.js';

/** A link in a Markdown document, with where it is. */
export type Link = {
  readonly target: string;
  readonly line: number;
  readonly column: number;
};

type Destination = { readonly target: string; readonly end: number };

/** A bare destination: up to white space or the `)` that closes the link, parentheses balanced. */
function bareDestination(text: string, start: number): Destination {
  let depth = 0;
  let index = start;
  for (; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (/\s/.test(char) || (char === ')' && depth === 0)) break;
    if (char === '\\') index += 1;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
  }
  return { target: text.slice(start, index), end: index };
}

/** The destination of an inline link starting at `from` (just after `](`), and where it ends. */
function destination(text: string, from: number): Destination | undefined {
  let index = from;
  while (text[index] === ' ' || text[index] === '\t') index += 1;
  if (text[index] !== '<') return bareDestination(text, index);
  const close = text.indexOf('>', index);
  if (close === -1 || text.slice(index, close).includes('\n')) return undefined;
  return { target: text.slice(index + 1, close), end: close + 1 };
}

/** The offset after the `]` that closes the bracket opened at `open`, nested brackets allowed. */
function closingBracket(text: string, open: number): number | undefined {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') index += 1;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    } else if (char === '\n' && text[index + 1] === '\n') return undefined;
  }
  return undefined;
}

function inlineLinks(masked: string): { target: string; offset: number }[] {
  const found: { target: string; offset: number }[] = [];
  for (const match of masked.matchAll(/\[/g)) {
    const close = closingBracket(masked, match.index);
    if (close === undefined || masked[close] !== '(') continue;
    const dest = destination(masked, close + 1);
    if (dest !== undefined) found.push({ target: dest.target, offset: close + 1 });
  }
  return found;
}

function definitions(masked: string): { target: string; offset: number }[] {
  return [...masked.matchAll(/^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm)].map((match) => {
    const raw = match[1] ?? '';
    const target = raw.startsWith('<') ? raw.slice(1, -1) : raw;
    return { target, offset: match.index + match[0].length - raw.length };
  });
}

function htmlLinks(masked: string): { target: string; offset: number }[] {
  return [...masked.matchAll(/<(?:a|img)\s[^>]*?\b(?:href|src)=["']([^"']*)["']/gi)].map(
    (match) => ({ target: match[1] ?? '', offset: match.index }),
  );
}

/** Every inline link, image, reference definition and HTML link outside code. */
export function markdownLinks(text: string): Link[] {
  const masked = maskCode(text);
  return [...inlineLinks(masked), ...definitions(masked), ...htmlLinks(masked)]
    .sort((a, b) => a.offset - b.offset)
    .map(({ target, offset }) => ({ target, ...position(masked, offset) }));
}

export type Target =
  | { readonly kind: 'external' }
  | { readonly kind: 'outside' }
  | { readonly kind: 'local'; readonly path: string; readonly anchor?: string };

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A link's path and anchor, its query dropped. */
function split(target: string): { path: string; anchor: string } {
  const hash = target.indexOf('#');
  const beforeHash = hash === -1 ? target : target.slice(0, hash);
  const query = beforeHash.indexOf('?');
  return {
    path: query === -1 ? beforeHash : beforeHash.slice(0, query),
    anchor: hash === -1 ? '' : decode(target.slice(hash + 1)),
  };
}

/**
 * Where a link from `from` (a repository-relative file) leads: off-site; above the repository's
 * root, as GitHub's `../../issues` leads to the repository's pages; or to a repository path
 * (`''` for the document itself) and an optional anchor.
 */
export function resolveLink(from: string, target: string): Target {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target) || target === '') return { kind: 'external' };
  const { path: rawPath, anchor } = split(target);
  const withAnchor = anchor === '' ? {} : { anchor };
  if (rawPath === '') return { kind: 'local', path: '', ...withAnchor };
  const decoded = decode(rawPath);
  const joined = decoded.startsWith('/')
    ? decoded.slice(1)
    : posix.join(posix.dirname(from), decoded);
  const path = posix.normalize(joined).replace(/\/$/, '');
  if (path === '..' || path.startsWith('../')) return { kind: 'outside' };
  return { kind: 'local', path: path === '.' ? '' : path, ...withAnchor };
}
