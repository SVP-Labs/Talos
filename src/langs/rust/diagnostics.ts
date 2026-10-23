import { z } from 'zod';
import { EngineError } from '../../core/check.js';

/** Where a diagnostic points, with its file as the compiler printed it. */
export type Site = {
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  readonly column: number;
};

/** One compiler diagnostic: a rustc or Clippy lint, or an error. */
export type Diagnostic = {
  /** A lint's name (`dead_code`, `clippy::unwrap_used`) or an error code (`E0308`). */
  readonly code?: string;
  readonly level: 'error' | 'warning';
  readonly message: string;
  /** The first site in the project's own files, following macro expansions outwards. */
  readonly site?: Site;
};

const spanSchema = z.object({
  file_name: z.string(),
  line_start: z.number().int(),
  line_end: z.number().int(),
  column_start: z.number().int(),
  is_primary: z.boolean(),
  expansion: z.object({ span: z.unknown() }).nullish(),
});

const messageSchema = z.object({
  reason: z.literal('compiler-message'),
  message: z.object({
    message: z.string(),
    code: z.object({ code: z.string() }).nullish(),
    level: z.string(),
    spans: z.array(spanSchema),
  }),
});

type Span = z.infer<typeof spanSchema>;

const SUMMARY = /^(aborting due to|\d+ warnings? emitted|for more information about)/i;

/**
 * The site in the project's files a span stands for: the span itself, or for code a macro
 * expanded, the place the macro was called.
 */
export function ownSite(span: Span, own: (file: string) => boolean, depth = 0): Site | undefined {
  if (own(span.file_name)) {
    return {
      file: span.file_name,
      line: span.line_start,
      endLine: Math.max(span.line_start, span.line_end),
      column: span.column_start,
    };
  }
  const outer = spanSchema.safeParse(span.expansion?.span);
  return outer.success && depth < 32 ? ownSite(outer.data, own, depth + 1) : undefined;
}

function levelOf(level: string): Diagnostic['level'] | undefined {
  if (level === 'warning') return 'warning';
  if (level === 'error') return 'error';
  if (level.startsWith('error: internal compiler error')) {
    throw new EngineError('rustc crashed (an internal compiler error)');
  }
  return undefined;
}

function identity(d: Diagnostic): string {
  const at = d.site === undefined ? '' : `${d.site.file}:${d.site.line}:${d.site.column}`;
  return `${d.level}|${d.code ?? ''}|${d.message}|${at}`;
}

function readLine(line: string, own: (file: string) => boolean): Diagnostic | undefined {
  if (!line.startsWith('{')) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new EngineError(`cargo printed a line that isn't JSON: ${line.slice(0, 200)}`);
  }
  const parsed = messageSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const { message } = parsed.data;
  const level = levelOf(message.level);
  if (level === undefined) return undefined;
  if (message.spans.length === 0 && SUMMARY.test(message.message)) return undefined;
  const primary = message.spans.find((span) => span.is_primary);
  const site = primary === undefined ? undefined : ownSite(primary, own);
  return {
    level,
    message: message.message,
    ...(message.code?.code === undefined ? {} : { code: message.code.code }),
    ...(site === undefined ? {} : { site }),
  };
}

/**
 * The compiler's messages from cargo's `--message-format=json` stream, each once: with
 * `--all-targets` a library is compiled twice (as itself and with its tests), and both
 * compilations report the code they share.
 */
export function parseDiagnostics(stdout: string, own: (file: string) => boolean): Diagnostic[] {
  const seen = new Set<string>();
  const found: Diagnostic[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const diagnostic = readLine(line.trim(), own);
    if (diagnostic === undefined || seen.has(identity(diagnostic))) continue;
    seen.add(identity(diagnostic));
    found.push(diagnostic);
  }
  return found;
}

/** A compiler message as one sentence: capitalised, with a full stop. */
export function sentence(message: string): string {
  const flat = message.replaceAll(/\s+/g, ' ').trim();
  const capital = `${flat.charAt(0).toUpperCase()}${flat.slice(1)}`;
  const clipped = capital.length > 300 ? `${capital.slice(0, 297)}...` : capital;
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}
