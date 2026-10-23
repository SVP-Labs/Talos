import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type Declaration, pinned } from './declaration.js';
import { runtimeNamed } from './runtimes.js';
import { EngineError } from '../../core/check.js';
import { setsKey } from '../../core/literal.js';

/** Talos's own lockfile of outside tools, at the repository root. */
export const TOOLS_LOCK = 'tools.lock';

/** `runtimes` maps each interpreter Talos installs tools into to its version. */
const lockSchema = z.object({ runtimes: z.record(z.string(), z.string().min(1)) });

/** The line of `name`'s key after the `runtimes` key, so a tool of the same name can't match. */
function entryLine(text: string, name: string): number {
  const lines = text.split(/\r?\n/);
  const section = lines.findIndex((line) => setsKey(line, 'runtimes', ':'));
  const index = lines.findIndex((line, at) => at > section && setsKey(line, name, ':'));
  return index < 0 ? 1 : index + 1;
}

function readLock(text: string): Record<string, string> {
  try {
    return lockSchema.safeParse(parseYaml(text)).data?.runtimes ?? {};
  } catch {
    return {};
  }
}

/**
 * The runtimes `tools.lock` pins under `runtimes`. A file of another shape declares nothing; a
 * runtime Talos doesn't know is an engine error, since only Talos writes this file.
 */
export function toolsLockDeclarations(file: string, text: string): Declaration[] {
  return Object.entries(readLock(text)).map(([name, written]) => {
    const runtime = runtimeNamed(name);
    if (runtime === undefined) {
      throw new EngineError(`${file} pins the runtime "${name}", which Talos doesn't know`);
    }
    const version = written.replace(/^v(?=\d)/, '');
    return pinned(runtime, { file, line: entryLine(text, name) }, written, version);
  });
}
