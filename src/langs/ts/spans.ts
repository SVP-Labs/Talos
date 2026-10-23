import { z } from 'zod';
import { componentDir, parseJson, TOOL_ENV } from './node.js';
import { type CheckContext, EngineError } from '../../core/check.js';

/** A position a finding reports, 1-based, in a file given by its absolute path. */
export type SpanQuestion = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
};

/**
 * Runs in the component's own Node with its own TypeScript (resolved from its root): for each
 * position, the last line of the innermost function whose code contains it, or null.
 */
export const SPAN_SCRIPT = String.raw`
const ts = require('typescript');
const fs = require('node:fs');
const asks = JSON.parse(fs.readFileSync(0, 'utf8'));
const sources = new Map();
function source(file) {
  if (!sources.has(file)) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
    sources.set(file, text === null ? null : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  }
  return sources.get(file);
}
function endOf(ask) {
  const sf = source(ask.file);
  if (sf === null) return null;
  const lines = sf.getLineStarts();
  if (ask.line < 1 || ask.line > lines.length) return null;
  const pos = lines[ask.line - 1] + ask.column - 1;
  let found = null;
  const visit = (node) => {
    if (pos < node.getStart(sf) || pos >= node.getEnd()) return;
    if (ts.isFunctionLike(node) && node.body !== undefined) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found === null ? null : sf.getLineAndCharacterOfPosition(found.getEnd()).line + 1;
}
process.stdout.write(JSON.stringify(asks.map(endOf)));
`;

const answers = z.array(z.number().int().positive().nullable());

/** The end line of the function each position sits in; null where there is none. */
export async function functionEnds(
  ctx: Pick<CheckContext, 'root' | 'component' | 'exec'>,
  questions: readonly SpanQuestion[],
): Promise<readonly (number | null)[]> {
  if (questions.length === 0) return [];
  const result = await ctx.exec(process.execPath, ['-e', SPAN_SCRIPT], {
    cwd: componentDir(ctx),
    env: TOOL_ENV,
    input: JSON.stringify(questions),
  });
  if (result.code !== 0) {
    throw new EngineError(`finding function spans failed: ${result.stderr.trim().slice(0, 300)}`);
  }
  const parsed = answers.safeParse(parseJson('the span finder', result.stdout));
  if (!parsed.success || parsed.data.length !== questions.length) {
    throw new EngineError('the span finder answered something Talos cannot read');
  }
  return parsed.data;
}
