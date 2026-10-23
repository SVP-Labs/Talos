import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { componentDir, inRepo, isTestPath, rustFiles } from './paths.js';
import type { Bound } from './run.js';
import { type FileShape, MAX_DEPTH, shapeOf, type Span } from './structure.js';
import type { Finding } from '../../core/finding.js';

const MAX_FILE_LINES = 400;

/** Every Rust file of a component, by its path relative to the component's root. */
export type Shapes = {
  readonly files: ReadonlyMap<string, FileShape>;
  /** Files only tests compile: under `tests/` or `benches/`, or declared as test modules. */
  readonly testFiles: ReadonlySet<string>;
};

/** Where the files of the modules a file declares live. */
function moduleDirs(file: string): string[] {
  const dir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
  const stem = posix.basename(file, '.rs');
  return [dir, posix.join(dir, stem)];
}

/** Where the file of module `name`, declared in `file`, may be. */
function moduleCandidates(file: string, name: string): string[] {
  return moduleDirs(file).flatMap((dir) => [
    posix.join(dir, `${name}.rs`),
    posix.join(dir, name, 'mod.rs'),
  ]);
}

/** The files `#[cfg(test)] mod name;` declarations point at, among the known files. */
function testModuleFiles(files: ReadonlyMap<string, FileShape>): Set<string> {
  const candidates = [...files].flatMap(([file, shape]) =>
    shape.testModules.flatMap((name) => moduleCandidates(file, name)),
  );
  return new Set(candidates.filter((path) => files.has(path)));
}

export function classify(files: ReadonlyMap<string, FileShape>): Shapes {
  const modules = testModuleFiles(files);
  const testFiles = new Set(
    [...files]
      .filter(([file, shape]) => isTestPath(file) || shape.wholeFileTest || modules.has(file))
      .map(([file]) => file),
  );
  return { files, testFiles };
}

/** Reads and measures the component's Rust files, once per run. */
export async function shapes(ctx: Bound): Promise<Shapes> {
  return ctx.memo(`rust/shapes:${ctx.component.root}`, async () => {
    const dir = componentDir(ctx);
    const entries = await Promise.all(
      rustFiles(ctx).map(async (file): Promise<[string, FileShape]> => {
        const text = await readFile(join(dir, file), 'utf8').catch(() => '');
        return [file, shapeOf(text)];
      }),
    );
    return classify(new Map(entries));
  });
}

function within(spans: readonly Span[], line: number): boolean {
  return spans.some((span) => span.start <= line && line <= span.end);
}

/** Whether a line of a file (relative to the component) is test code. */
export function isTestCode(all: Shapes, file: string, line: number): boolean {
  if (all.testFiles.has(file)) return true;
  const shape = all.files.get(file);
  return shape !== undefined && within(shape.tests, line);
}

/** The lines that count towards the file limit: code outside test items. */
function counted(shape: FileShape): number[] {
  return [...shape.codeLines].filter((line) => !within(shape.tests, line)).sort((a, b) => a - b);
}

/** The file-size and nesting limits Clippy has no lint for, with repository-relative paths. */
export function shapeFindings(all: Shapes, root: string): Finding[] {
  const findings: Finding[] = [];
  for (const [file, shape] of all.files) {
    const path = inRepo(root, file);
    const lines = all.testFiles.has(file) ? [] : counted(shape);
    if (lines.length > MAX_FILE_LINES) {
      findings.push({
        rule: 'talos/max-lines',
        message: `This file has ${String(lines.length)} lines of code outside its tests; the most allowed is ${String(MAX_FILE_LINES)}.`,
        location: { file: path, line: lines[MAX_FILE_LINES] ?? 1, endLine: lines.at(-1) ?? 1 },
      });
    }
    for (const span of shape.deep) {
      findings.push({
        rule: 'talos/max-depth',
        message: `Blocks nest ${String(MAX_DEPTH + 1)} deep here; the most allowed is ${String(MAX_DEPTH)}.`,
        location: { file: path, line: span.start, endLine: span.end },
      });
    }
  }
  return findings;
}
