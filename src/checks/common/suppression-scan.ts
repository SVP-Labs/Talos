import {
  COMMENT_DIRECTIVES,
  type Directive,
  POWERSHELL_ATTRIBUTES,
  RUST_ATTRIBUTES,
} from './suppression-rules.js';
import { commentsIn, SOURCE_GLOBS } from '../../docs/comments/index.js';

/** One suppression: the directive's kind, its 1-based line, and what it does. */
export type Suppression = {
  readonly kind: string;
  readonly line: number;
  readonly message: string;
};

type CommentText = { readonly line: number; readonly text: string };

const PYTHON = /\.pyi?$/;
const POWERSHELL = /\.ps[dm]?1$/i;
const HASH_COMMENTED =
  /(?:^|\/)(?:Dockerfile|Containerfile)(?:\.[^/]*)?$|\.(?:dockerfile|ya?ml|toml)$/i;
const MARKDOWN = /\.(?:md|markdown)$/i;

/** Source code, container files, workflows and configs, and docs. */
export const SUPPRESSION_GLOBS: readonly string[] = [
  ...SOURCE_GLOBS,
  '**/{Dockerfile,Containerfile}',
  '**/{Dockerfile,Containerfile}.*',
  '**/*.{Dockerfile,dockerfile}',
  '**/*.{yml,yaml,toml}',
  '**/*.{md,markdown}',
];

/** Comments of a language Talos reads; a Python docstring is a string, not a comment. */
function sourceComments(file: string, text: string): CommentText[] {
  const python = PYTHON.test(file);
  return commentsIn(file, text).filter((comment) => !(python && comment.doc));
}

/** `#` comments: a `#` at a line's start or after white space, to the line's end. */
function hashComments(text: string): CommentText[] {
  return text.split('\n').flatMap((line, index) => {
    const match = /(?:^|\s)#(.*)$/.exec(line);
    return match === null ? [] : [{ line: index + 1, text: (match[1] ?? '').trim() }];
  });
}

/** The lines with fenced code blanked and inline code spaced out, keeping every offset. */
function proseOnly(text: string): string {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line.replaceAll(/`[^`]*`/g, (code) => ' '.repeat(code.length));
    })
    .join('\n');
}

/** HTML comments in Markdown prose, line by line. */
function markdownComments(text: string): CommentText[] {
  const prose = proseOnly(text);
  return [...prose.matchAll(/<!--([\s\S]*?)-->/g)].flatMap((match) => {
    const first = prose.slice(0, match.index).split('\n').length;
    return (match[1] ?? '').split('\n').map((body, index) => ({
      line: first + index,
      text: body.trim(),
    }));
  });
}

function commentTexts(file: string, text: string): CommentText[] {
  if (HASH_COMMENTED.test(file)) return hashComments(text);
  if (MARKDOWN.test(file)) return markdownComments(text);
  return sourceComments(file, text);
}

function attributesFor(file: string): readonly Directive[] {
  if (file.endsWith('.rs')) return RUST_ATTRIBUTES;
  return POWERSHELL.test(file) ? POWERSHELL_ATTRIBUTES : [];
}

function matches(lines: readonly CommentText[], directives: readonly Directive[]): Suppression[] {
  return lines.flatMap(({ line, text }) =>
    directives
      .filter((directive) => directive.pattern.test(text))
      .map((directive) => ({ kind: directive.kind, line, message: directive.message })),
  );
}

/**
 * Every suppression in a file: a directive in a comment that silences a linter, a type checker,
 * a formatter, coverage, mutation or a scanner, and Rust's and PowerShell's attributes that do
 * the same. One per kind and line, in line order.
 */
export function suppressionsIn(file: string, text: string): Suppression[] {
  const attributes = attributesFor(file);
  const code =
    attributes.length === 0
      ? []
      : text.split('\n').map((line, index) => ({ line: index + 1, text: line }));
  const found = [
    ...matches(commentTexts(file, text), COMMENT_DIRECTIVES),
    ...matches(code, attributes),
  ];
  const seen = new Set<string>();
  return found
    .filter((hit) => {
      const key = `${hit.line}:${hit.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line);
}
