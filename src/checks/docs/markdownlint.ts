import { z } from 'zod';
import { withoutTrailingSlashes } from './files.js';
import { generatedHeader } from '../../configs/header.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

export const MARKDOWNLINT_CONFIG = '.markdownlint-cli2.jsonc';

/** markdownlint's rules, every one on, with prose lines up to 100 outside tables and code. */
export const MARKDOWNLINT_RULES = {
  default: true,
  MD013: { line_length: 100, tables: false, code_blocks: false },
} as const;

/** Globs for what `talos.yml` excludes: each entry as a file and as a directory. */
export function excludeGlobs(exclude: readonly string[]): string[] {
  return exclude.flatMap((entry) => {
    const trimmed = withoutTrailingSlashes(entry);
    return [trimmed, `${trimmed}/**`];
  });
}

/** A JSON array on one line when it fits in `width` after `prefix`, else one item a line. */
function jsonArray(prefix: string, items: readonly string[], width = 100): string {
  const inline = `${prefix}[${items.map((item) => JSON.stringify(item)).join(', ')}],`;
  if (inline.length <= width) return inline;
  const indent = /^\s*/.exec(prefix)?.[0] ?? '';
  const lines = items.map((item) => `${indent}  ${JSON.stringify(item)},`);
  return [`${prefix}[`, ...lines, `${indent}],`].join('\n');
}

function inlineObject(value: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(value).map(([key, item]) => `"${key}": ${JSON.stringify(item)}`);
  return `{ ${entries.join(', ')} }`;
}

/**
 * The base for editors and `markdownlint-cli2`, written as Prettier writes it. Inline
 * `markdownlint-disable` comments do nothing. It has no extension file: every rule is already
 * on, and the line length is the kit's.
 */
export function renderMarkdownlintBase(version: string, exclude: readonly string[]): string {
  // A PR template is a form of HTML comments to fill in, not a document.
  const ignores = ['**/node_modules/**', '**/pull_request_template.md', ...excludeGlobs(exclude)];
  return [
    generatedHeader('//', version).trimEnd(),
    "// markdownlint's rules for every Markdown file, lines up to 100 outside tables and code.",
    '{',
    '  "config": {',
    '    "default": true,',
    `    "MD013": ${inlineObject(MARKDOWNLINT_RULES.MD013)},`,
    '  },',
    jsonArray('  "globs": ', ['**/*.md']),
    jsonArray('  "ignores": ', ignores),
    '  "gitignore": true,',
    '  "noInlineConfig": true,',
    '}',
    '',
  ].join('\n');
}

const lintError = z.object({
  lineNumber: z.number().int().positive(),
  ruleNames: z.array(z.string()).min(1),
  ruleDescription: z.string(),
  errorDetail: z.string().nullable(),
  errorRange: z.tuple([z.number(), z.number()]).nullable(),
});

const lintResults = z.record(z.string(), z.array(lintError));

function sentence(description: string, detail: string | null): string {
  const text = detail === null || detail === '' ? description : `${description} (${detail})`;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Findings from markdownlint's results, keyed by repository-relative file. */
export function markdownlintFindings(results: unknown): Finding[] {
  const parsed = lintResults.safeParse(results);
  if (!parsed.success) throw new EngineError('markdownlint returned results Talos cannot read');
  return Object.entries(parsed.data).flatMap(([file, errors]) =>
    errors.map((error) => ({
      rule: `markdownlint/${error.ruleNames[0] ?? 'unknown'}`,
      message: sentence(error.ruleDescription, error.errorDetail),
      location: {
        file,
        line: error.lineNumber,
        ...(error.errorRange === null ? {} : { column: error.errorRange[0] }),
      },
    })),
  );
}
