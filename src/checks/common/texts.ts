import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { carriesGeneratedMarker } from '../../configs/header.js';

/** A tracked file's text, by its repository-relative path. */
export type Text = { readonly file: string; readonly text: string };

/** Larger files are bundles or data, not code anyone wrote. */
const MAX_BYTES = 2_000_000;
/** Files read at once, so thousands of them never run out of file handles. */
const CHUNK = 64;

async function readOne(root: string, file: string): Promise<Text | undefined> {
  try {
    const path = join(root, file);
    if ((await stat(path)).size > MAX_BYTES) return undefined;
    return { file, text: await readFile(path, 'utf8') };
  } catch {
    return undefined;
  }
}

/**
 * The project's own files among `files`: the ones it can read, minus the configs Talos rendered,
 * which the gate rewrites before any check and so are never the project's to fix.
 */
export async function ownTexts(root: string, files: readonly string[]): Promise<Text[]> {
  const texts: Text[] = [];
  for (let start = 0; start < files.length; start += CHUNK) {
    const chunk = files.slice(start, start + CHUNK);
    for (const text of await Promise.all(chunk.map((file) => readOne(root, file)))) {
      if (text !== undefined && !carriesGeneratedMarker(text.text)) texts.push(text);
    }
  }
  return texts;
}
