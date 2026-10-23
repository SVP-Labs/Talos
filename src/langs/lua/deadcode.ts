import { eventFinding, isDeadCode, luacheck, type LuacheckFile } from './luacheck.js';
import type { Bound } from './run.js';
import type { Finding } from '../../core/finding.js';

/** luacheck's unused-code warnings, which lua/lint leaves out so each appears once. */
export function deadCodeFindings(ctx: Bound, files: readonly LuacheckFile[]): Finding[] {
  return files.flatMap((file) =>
    file.events.filter((e) => isDeadCode(e.code)).map((e) => eventFinding(ctx, file.file, e)),
  );
}

/** Unused variables, arguments, values and labels, and unreachable code, from luacheck. */
export async function deadCode(ctx: Bound): Promise<Finding[]> {
  const run = await luacheck(ctx);
  return run.kind === 'config' ? [] : deadCodeFindings(ctx, run.files);
}
