import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Talos's working folder in a checkout it judges: `talos check`'s reports, the base runs' cache
 * and the worktrees they run in. It ignores itself, so git lists nothing Talos leaves in it and
 * no commit of everything takes it along.
 */
const TALOS_DIR = '.talos';

/** Everything in the folder, the ignore file included. */
const IGNORE_ALL = '*\n';

/** `.talos/<parts>` under `root`, where it is or would be; nothing is created. */
export function talosPath(root: string, ...parts: readonly string[]): string {
  return join(root, TALOS_DIR, ...parts);
}

function exists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/**
 * Creates `.talos/<parts>` under `root` and returns its path. Every way into the folder goes
 * through here, so `.talos/.gitignore` is written with it, holding `*`. One already there is
 * left as it is, whatever it holds: Talos wrote it, or someone put their own there on purpose.
 */
export async function createTalosDir(root: string, ...parts: readonly string[]): Promise<string> {
  await mkdir(talosPath(root), { recursive: true });
  try {
    await writeFile(talosPath(root, '.gitignore'), IGNORE_ALL, { flag: 'wx' });
  } catch (error) {
    if (!exists(error)) throw error;
  }
  const path = talosPath(root, ...parts);
  await mkdir(path, { recursive: true });
  return path;
}
