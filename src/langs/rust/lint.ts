import { compiled, toFinding } from './compile.js';
import type { Diagnostic } from './diagnostics.js';
import { inComponent } from './paths.js';
import type { Bound } from './run.js';
import { isTestCode, shapeFindings, type Shapes, shapes } from './shapes.js';
import type { Finding } from '../../core/finding.js';

/** Lints rust/deadcode reports instead. */
export const DEAD_CODE = 'dead_code';

/** Size limits that tests are exempt from, as they are from ESLint's. */
const SIZE_LINTS = new Set(['clippy::too_many_lines']);

/** The warnings rust/lint reports: every lint but dead code, and no size limit in tests. */
export function lintDiagnostics(
  diagnostics: readonly Diagnostic[],
  all: Shapes,
  root: string,
): Diagnostic[] {
  return diagnostics.filter((d) => {
    if (d.level !== 'warning' || d.code === DEAD_CODE) return false;
    if (d.site === undefined || !SIZE_LINTS.has(d.code ?? '')) return true;
    const file = inComponent(root, d.site.file);
    return file === undefined || !isTestCode(all, file, d.site.line);
  });
}

/** Clippy and rustc lints at Talos's levels, plus the file-size and nesting limits. */
export async function lint(ctx: Bound): Promise<Finding[]> {
  const [diagnostics, all] = await Promise.all([compiled(ctx), shapes(ctx)]);
  const root = ctx.component.root;
  return [...lintDiagnostics(diagnostics, all, root).map(toFinding), ...shapeFindings(all, root)];
}
