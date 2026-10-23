import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { EngineError } from '../core/check.js';

/** The file in a cached tool's directory naming what was installed there. */
export const STAMP = '.talos-tool';

async function stamped(dir: string, stamp: string): Promise<boolean> {
  try {
    return (await readFile(join(dir, STAMP), 'utf8')) === stamp;
  } catch {
    return false;
  }
}

async function moved(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts the filled work directory in place. When the rename fails, either another process
 * placed the same tool first, which is kept, or an older or broken entry is in the way, which
 * is moved aside and replaced.
 */
async function settle(work: string, dir: string, stamp: string): Promise<void> {
  if (await moved(work, dir)) return;
  if (await stamped(dir, stamp)) return;
  const aside = `${work}.old`;
  await moved(dir, aside);
  const landed = await moved(work, dir);
  await rm(aside, { recursive: true, force: true });
  if (!landed && !(await stamped(dir, stamp))) {
    throw new EngineError(`could not put a tool in place at ${dir}`);
  }
}

/**
 * Makes `dir` hold what `fill` writes into an empty directory, marked with `stamp`. The work
 * happens beside `dir` under a temporary name and lands with one rename, so a directory with
 * the stamp is always complete, and processes filling it at once all end with one copy.
 * Returns whether it had to fill it.
 */
export async function ensureDir(
  dir: string,
  stamp: string,
  fill: (work: string) => Promise<void>,
): Promise<boolean> {
  if (await stamped(dir, stamp)) return false;
  await mkdir(dirname(dir), { recursive: true });
  const work = await mkdtemp(join(dirname(dir), `.${basename(dir)}-`));
  try {
    await fill(work);
    await writeFile(join(work, STAMP), stamp);
    await settle(work, dir, stamp);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return true;
}
