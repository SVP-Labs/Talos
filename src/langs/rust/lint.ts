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

/** Lints about a whole function, which Clippy reports on its signature or name. */
const FUNCTION_LINTS = new Set([
  'clippy::too_many_lines',
  'clippy::cognitive_complexity',
  'clippy::too_many_arguments',
]);

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

/**
 * A function-level lint widened from the signature to the function's closing brace, so a change
 * to any line of the function touches it.
 */
export function widened(d: Diagnostic, all: Shapes, root: string): Diagnostic {
  const site = d.site;
  if (site === undefined || !FUNCTION_LINTS.has(d.code ?? '')) return d;
  const file = inComponent(root, site.file);
  const functions = file === undefined ? [] : (all.files.get(file)?.functions ?? []);
  const fn = functions.findLast((f) => f.start <= site.line && site.line <= f.open);
  return fn === undefined
    ? d
    : { ...d, site: { ...site, endLine: Math.max(site.endLine, fn.end) } };
}

/** Clippy and rustc lints at Talos's levels, plus the file-size and nesting limits. */
export async function lint(ctx: Bound): Promise<Finding[]> {
  const [diagnostics, all] = await Promise.all([compiled(ctx), shapes(ctx)]);
  const root = ctx.component.root;
  const lints = lintDiagnostics(diagnostics, all, root).map((d) => widened(d, all, root));
  return [...lints.map(toFinding), ...shapeFindings(all, root)];
}
