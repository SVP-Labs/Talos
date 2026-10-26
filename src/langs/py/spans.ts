import { z } from 'zod';
import { runScript, type ToolContext, jsonFrom } from './run.js';
import { EngineError } from '../../core/check.js';

/**
 * Lists every function's lines and every docstring's, through Python's own parser. Paths come
 * one per line on standard input; a file that doesn't parse maps to null (ruff reports it).
 */
const SCRIPT = String.raw`import ast
import json
import sys


def docstring(node, found):
    body = getattr(node, "body", None)
    if isinstance(body, list) and body and isinstance(body[0], ast.Expr):
        value = body[0].value
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            found.append([body[0].lineno, body[0].end_lineno])


def walk(node, owner, out):
    docstring(node, out["docstrings"])
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start = min([d.lineno for d in child.decorator_list] + [child.lineno])
            out["functions"].append(
                {"name": child.name, "owner": owner, "start": start, "end": child.end_lineno}
            )
            walk(child, None, out)
        elif isinstance(child, ast.ClassDef):
            walk(child, child.name if owner == "" else None, out)
        else:
            walk(child, owner, out)


def spans(path):
    try:
        with open(path, encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), path)
    except (OSError, SyntaxError, ValueError):
        return None
    out = {"functions": [], "docstrings": []}
    walk(tree, "", out)
    return out


paths = [line for line in sys.stdin.read().splitlines() if line]
print(json.dumps({path: spans(path) for path in paths}))
`;

const fn = z.object({
  name: z.string(),
  owner: z.string().nullable(),
  start: z.number().int(),
  end: z.number().int(),
});

const fileSpans = z.object({
  functions: z.array(fn),
  docstrings: z.array(z.tuple([z.number().int(), z.number().int()])),
});

/**
 * A function's lines, from its first decorator to its last line. `owner` is `''` for a
 * module-level function, the class's name for a method of a module-level class, null otherwise.
 */
export type FunctionSpan = z.infer<typeof fn>;
export type FileSpans = z.infer<typeof fileSpans>;

export function parseSpans(text: string): Map<string, FileSpans> {
  const parsed = z.record(z.string(), fileSpans.nullable()).safeParse(jsonFrom(text, 'spans'));
  if (!parsed.success) throw new EngineError('the span script printed JSON of an unknown shape');
  const spans = new Map<string, FileSpans>();
  for (const [file, value] of Object.entries(parsed.data)) if (value) spans.set(file, value);
  return spans;
}

/** Function and docstring spans of component-relative files that parse. */
export async function readSpans(
  ctx: ToolContext,
  files: readonly string[],
): Promise<Map<string, FileSpans>> {
  if (files.length === 0) return new Map();
  return parseSpans(await runScript(ctx, 'talos_spans.py', SCRIPT, files.join('\n')));
}
