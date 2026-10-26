import { z } from 'zod';
import { withoutTrailingSlashes } from './paths.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

const position = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});

const diagnostic = z.object({
  code: z.string().optional(),
  message: z.string(),
  range: z.object({ start: position, end: position }),
});

/** An empty result is written as an empty array, since Lua's tables don't tell the two apart. */
const results = z.union([z.record(z.string(), z.array(diagnostic)), z.tuple([])]);

export type Diagnostic = z.infer<typeof diagnostic>;

/** `lua-language-server --check` with `--check_format=json`: diagnostics by file URI. */
export function parseCheck(text: string): Map<string, Diagnostic[]> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new EngineError(`lua-language-server wrote no readable JSON: ${text.slice(0, 200)}`);
  }
  const parsed = results.safeParse(value);
  if (!parsed.success) throw new EngineError('lua-language-server wrote an unknown shape');
  return new Map(Array.isArray(parsed.data) ? [] : Object.entries(parsed.data));
}

/** A `file:` URI's path, with a Windows drive letter's leading slash dropped. */
export function uriPath(uri: string): string | undefined {
  if (!uri.startsWith('file:///')) return undefined;
  const path = decodeURIComponent(uri.slice('file://'.length));
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

function trimmed(path: string): string {
  return withoutTrailingSlashes(path.replaceAll('\\', '/'));
}

/**
 * `path` relative to `dir`, or undefined outside it. LuaLS lowercases a Windows drive letter,
 * and Windows paths ignore case, so there the comparison does too.
 */
export function relativeTo(dir: string, path: string, windows: boolean): string | undefined {
  const base = `${trimmed(dir)}/`;
  const full = trimmed(path);
  const [b, f] = windows ? [base.toLowerCase(), full.toLowerCase()] : [base, full];
  return f.startsWith(b) ? full.slice(base.length) : undefined;
}

/** LuaLS's first line, which says what is wrong; the lines after it explain the types. */
export function headline(message: string): string {
  const first = (message.split('\n')[0] ?? '').trim();
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

export type CheckedFile = {
  /** Component-relative. */
  readonly file: string;
  /** Repository-relative. */
  readonly repoFile: string;
  readonly diagnostics: readonly Diagnostic[];
};

export function diagnosticFindings(files: readonly CheckedFile[]): Finding[] {
  return files.flatMap(({ repoFile, diagnostics }) =>
    diagnostics.map((d) => ({
      rule: `luals/${d.code ?? 'syntax'}`,
      message: headline(d.message),
      location: {
        file: repoFile,
        line: d.range.start.line + 1,
        endLine: Math.max(d.range.start.line, d.range.end.line) + 1,
        column: d.range.start.character + 1,
      },
    })),
  );
}
