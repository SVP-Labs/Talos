import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { GENERATED_PATHS } from './configs/index.js';
import { mapInChunks } from './node.js';
import { GENERATED_MARKER } from '../../configs/header.js';

/** Whether a file's first lines carry the generated-file marker (any pack's). */
export async function carriesMarker(path: string): Promise<boolean> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (handle === undefined) return false;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(300), 0, 300, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').includes(GENERATED_MARKER);
  } finally {
    await handle.close();
  }
}

/**
 * Leaves out the files Talos renders: the gate rewrites them before any check, so a finding in
 * one is Talos's to fix, never the project's. Paths are relative to `dir`.
 */
export async function withoutGenerated(dir: string, files: readonly string[]): Promise<string[]> {
  const known = new Set(GENERATED_PATHS);
  const candidates = files.filter((file) => !known.has(file));
  const marked = await mapInChunks(candidates, (file) => carriesMarker(join(dir, file)));
  return candidates.filter((_, index) => marked[index] !== true);
}
