import { join } from 'node:path';
import { eventFinding, isDeadCode, luacheck, type LuacheckFile } from './luacheck.js';
import { componentDir, fileExists, inRepo, LUACHECK_PROJECT } from './paths.js';
import type { Bound } from './run.js';
import { type FileShape, measureShapes, shapeCheck } from './shape.js';
import type { Finding } from '../../core/finding.js';

/** Where each function of each file ends, by the line it starts on. */
export function functionEnds(shapes: readonly FileShape[]): Map<string, Map<number, number>> {
  return new Map(
    shapes.map((shape) => [
      shape.file,
      new Map(shape.functions.map((fn) => [fn.line, fn.endLine])),
    ]),
  );
}

/**
 * luacheck's warnings other than dead code. A function's cyclomatic complexity (W561) is
 * reported on its first line; it is widened to the whole function, so changing any line of the
 * function touches the finding.
 */
export function lintFindings(
  ctx: Bound,
  files: readonly LuacheckFile[],
  ends: ReadonlyMap<string, ReadonlyMap<number, number>>,
): Finding[] {
  return files.flatMap((file) =>
    file.events
      .filter((e) => !isDeadCode(e.code))
      .map((e) => {
        const finding = eventFinding(ctx, file.file, e);
        const end = e.code === '561' ? ends.get(file.file)?.get(e.line) : undefined;
        if (end === undefined || finding.location === undefined) return finding;
        return { ...finding, location: { ...finding.location, endLine: end } };
      }),
  );
}

async function configFinding(ctx: Bound, message: string): Promise<Finding> {
  const project = inRepo(ctx.component.root, LUACHECK_PROJECT);
  const exists = await fileExists(join(componentDir(ctx), LUACHECK_PROJECT));
  return {
    rule: 'luacheck/config',
    message: `luacheck could not load its configuration: ${message.slice(0, 160)}`,
    key: `${project} luacheck config`,
    ...(exists ? { location: { file: project, line: 1 } } : {}),
  };
}

/** luacheck, and the size, nesting and complexity limits it has no option for. */
export async function lint(ctx: Bound): Promise<Finding[]> {
  const [run, shapes] = await Promise.all([luacheck(ctx), measureShapes(ctx)]);
  const own = shapeCheck(ctx, shapes);
  if (run.kind === 'config') return [await configFinding(ctx, run.message), ...own];
  return [...lintFindings(ctx, run.files, functionEnds(shapes)), ...own];
}
