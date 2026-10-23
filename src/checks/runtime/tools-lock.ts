import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type Declaration, pinned } from './declaration.js';
import { runtimeNamed } from './runtimes.js';
import { EngineError } from '../../core/check.js';

/** Talos's own lockfile of outside tools, at the repository root. */
export const TOOLS_LOCK = 'tools.lock';

const lockSchema = z.object({ tools: z.record(z.string(), z.unknown()) });

/**
 * A runtime entry: `runtime` names the runtime the entry installs (`"python"`), or is `true`
 * when the entry's own name is the runtime.
 */
const entrySchema = z.object({
  version: z.string().min(1),
  runtime: z.union([z.string().min(1), z.literal(true)]),
});

function escaped(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function entryLine(text: string, name: string): number {
  const key = new RegExp(String.raw`^\s*["']?${escaped(name)}["']?\s*:`);
  const index = text.split(/\r?\n/).findIndex((line) => key.test(line));
  return index < 0 ? 1 : index + 1;
}

function readLock(text: string): Record<string, unknown> {
  try {
    return lockSchema.safeParse(parseYaml(text)).data?.tools ?? {};
  } catch {
    return {};
  }
}

/**
 * The runtimes `tools.lock` pins: entries under `tools` that carry a `runtime` field. A file of
 * another shape declares nothing; a runtime Talos doesn't know is an engine error, since only
 * Talos writes this file.
 */
export function toolsLockDeclarations(file: string, text: string): Declaration[] {
  return Object.entries(readLock(text)).flatMap(([name, value]) => {
    const entry = entrySchema.safeParse(value).data;
    if (entry === undefined) return [];
    const runtimeName = entry.runtime === true ? name : entry.runtime;
    const runtime = runtimeNamed(runtimeName);
    if (runtime === undefined) {
      throw new EngineError(
        `${file} marks ${name} as the runtime "${runtimeName}", which Talos doesn't know`,
      );
    }
    const version = entry.version.replace(/^v(?=\d)/, '');
    const written = name === runtime ? version : `${name} ${version}`;
    return [pinned(runtime, { file, line: entryLine(text, name) }, written, version)];
  });
}
