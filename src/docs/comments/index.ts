import { JS, PHP, phpResume, RUST } from './c-family.js';
import {
  type CodeShape,
  type CommentContext,
  type CommentProblem,
  judgeComments,
} from './rules.js';
import { type CommentLine, type Matcher, scan } from './scan.js';
import { LUA, POWERSHELL, PYTHON, SHELL } from './script.js';

type Syntax = {
  readonly matchers: readonly Matcher[];
  readonly shape?: CodeShape;
  /** Where code starts: PHP's opening tag. */
  readonly start?: (text: string) => number;
};

const SYNTAXES: readonly (readonly [RegExp, Syntax])[] = [
  [/\.(?:[cm]?[jt]s|[jt]sx)$/, { matchers: JS }],
  [/\.pyi?$/, { matchers: PYTHON }],
  [/\.php$/, { matchers: PHP, shape: 'php', start: (text) => phpResume(text, 0) }],
  [/\.lua$/, { matchers: LUA, shape: 'lua' }],
  [/\.rs$/, { matchers: RUST, shape: 'rust' }],
  [/\.(?:sh|bash)$/, { matchers: SHELL, shape: 'shell' }],
  [/\.ps[dm]?1$/, { matchers: POWERSHELL, shape: 'powershell' }],
];

/** The source files whose comments the rules read, by their extension. */
export const SOURCE_GLOBS = [
  '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
  '**/*.{py,pyi}',
  '**/*.php',
  '**/*.lua',
  '**/*.rs',
  '**/*.{sh,bash}',
  '**/*.{ps1,psm1,psd1}',
];

function syntaxFor(file: string): Syntax | undefined {
  return SYNTAXES.find(([pattern]) => pattern.test(file))?.[1];
}

/** A source file's comments, line by line; none for a file of no language it knows. */
export function commentsIn(file: string, text: string): CommentLine[] {
  const syntax = syntaxFor(file);
  if (syntax === undefined) return [];
  return scan(text, syntax.matchers, syntax.start?.(text) ?? 0);
}

/** What the comment rules find in one source file. */
export function commentProblems(file: string, text: string, ctx: CommentContext): CommentProblem[] {
  const syntax = syntaxFor(file);
  if (syntax === undefined) return [];
  return judgeComments(commentsIn(file, text), ctx, syntax.shape);
}

export type { CommentContext, CommentLine, CommentProblem };
