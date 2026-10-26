import { z } from 'zod';
import { fromTool, isTestPath, luaFiles } from './paths.js';
import { type Bound, chunks, parseJson, runScript } from './run.js';
import { SHAPE_SCRIPT } from './scripts/shape.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

/** The limits every language keeps; luacheck has only the cyclomatic one. */
export const LIMITS = {
  fileLines: 400,
  functionLines: 60,
  params: 4,
  depth: 3,
  cognitive: 15,
} as const;

const line = z.number().int().positive();

const deep = {
  depth: z.number().int().nonnegative(),
  deepLine: line,
  deepEndLine: line,
};

const measured = z.object({
  name: z.string(),
  line,
  endLine: line,
  params: z.number().int().nonnegative(),
  codeLines: z.number().int().nonnegative(),
  cognitive: z.number().int().nonnegative(),
  ...deep,
});

const fileShape = z.union([
  z.object({
    file: z.string(),
    error: z.literal(''),
    lines: z.number().int().nonnegative(),
    code: z.array(line),
    functions: z.array(measured),
    ...deep,
  }),
  z.object({ file: z.string(), error: z.enum(['syntax', 'unreadable']) }),
]);

const shapes = z.object({ files: z.array(fileShape) });

export type FunctionShape = z.infer<typeof measured>;

type Deep = { readonly depth: number; readonly deepLine: number; readonly deepEndLine: number };

export type FileShape = Deep & {
  readonly file: string;
  /** How many lines the file has. */
  readonly lines: number;
  /** The numbers of its lines that hold code, ascending. */
  readonly code: readonly number[];
  readonly functions: readonly FunctionShape[];
};

/** The shape script's output. A file luacheck can't parse is left out: lint reports E011. */
export function parseShapes(stdout: string): FileShape[] {
  const parsed = shapes.safeParse(parseJson(stdout.trim(), 'the shape script'));
  if (!parsed.success) throw new EngineError('the shape script printed an unknown shape');
  return parsed.data.files.flatMap((file): FileShape[] => {
    if (!('functions' in file)) {
      if (file.error === 'unreadable') throw new EngineError(`could not read ${file.file}`);
      return [];
    }
    return [file];
  });
}

function nameOf(fn: FunctionShape): string {
  return fn.name === '' ? 'an anonymous function' : `function '${fn.name}'`;
}

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function allowed(limit: number): string {
  return `the most allowed is ${limit}.`;
}

function functionFindings(file: string, fn: FunctionShape, test: boolean): Finding[] {
  const span = { file, line: fn.line, endLine: fn.endLine };
  const name = capitalised(nameOf(fn));
  const found: Finding[] = [];
  if (!test && fn.codeLines > LIMITS.functionLines) {
    found.push({
      rule: 'talos/max-lines-per-function',
      message: `${name} has ${fn.codeLines} lines of code; ${allowed(LIMITS.functionLines)}`,
      location: span,
    });
  }
  if (fn.params > LIMITS.params) {
    found.push({
      rule: 'talos/max-params',
      message: `${name} takes ${fn.params} parameters; ${allowed(LIMITS.params)}`,
      location: span,
    });
  }
  if (fn.cognitive > LIMITS.cognitive) {
    found.push({
      rule: 'talos/cognitive-complexity',
      message: `${name} has a cognitive complexity of ${fn.cognitive}; ${allowed(LIMITS.cognitive)}`,
      location: span,
    });
  }
  return found;
}

function depthFindings(file: string, where: string, shape: Deep): Finding[] {
  if (shape.depth <= LIMITS.depth) return [];
  return [
    {
      rule: 'talos/max-depth',
      message: `Blocks in ${where} are nested ${shape.depth} deep; ${allowed(LIMITS.depth)}`,
      location: { file, line: shape.deepLine, endLine: shape.deepEndLine },
    },
  ];
}

function fileFindings(file: string, shape: FileShape): Finding[] {
  const first = shape.code[LIMITS.fileLines];
  if (first === undefined) return [];
  return [
    {
      rule: 'talos/max-lines',
      message: `This file has ${shape.code.length} lines of code; ${allowed(LIMITS.fileLines)}`,
      location: { file, line: first, endLine: Math.max(first, shape.lines) },
    },
  ];
}

/**
 * The limits luacheck has no option for, kept as ESLint and Talos's own counts keep them in
 * the other languages: lines of code per file (from the first line over the limit) and per
 * function, which tests are exempt from; parameters; nesting; cognitive complexity. A finding
 * about a function spans the whole function. `file` is repository-relative.
 */
export function shapeFindings(file: string, shape: FileShape, test: boolean): Finding[] {
  return [
    ...(test ? [] : fileFindings(file, shape)),
    ...depthFindings(file, 'the main chunk', shape),
    ...shape.functions.flatMap((fn) => [
      ...functionFindings(file, fn, test),
      ...depthFindings(file, nameOf(fn), fn),
    ]),
  ];
}

/** Measures the component's Lua files, which come back component-relative. */
export async function measureShapes(ctx: Bound): Promise<FileShape[]> {
  const found: FileShape[] = [];
  for (const batch of chunks(luaFiles(ctx), 24_000)) {
    found.push(...parseShapes(await runScript(ctx, SHAPE_SCRIPT, batch)));
  }
  return found;
}

/** Each measured file's findings, with repository-relative paths. */
export function shapeCheck(ctx: Bound, measuredFiles: readonly FileShape[]): Finding[] {
  return measuredFiles.flatMap((shape) =>
    shapeFindings(fromTool(ctx, shape.file), shape, isTestPath(shape.file)),
  );
}
