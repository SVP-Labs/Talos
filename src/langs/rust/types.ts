import { compiled, toFinding } from './compile.js';
import type { Bound } from './run.js';
import type { Finding } from '../../core/finding.js';

/**
 * rustc's errors: type errors, borrow errors, unresolved names and syntax errors. Lints are
 * capped at warnings for the gate's run, so every error is the compiler's own.
 */
export async function types(ctx: Bound): Promise<Finding[]> {
  return (await compiled(ctx)).filter((d) => d.level === 'error').map(toFinding);
}
