import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GENERATED_MARKER } from '../../configs/header.js';
import type { ApplyContext, CheckContext } from '../../core/check.js';
import { KIT_BEGIN, KIT_END } from '../../docs/claude.js';
import type { DocText } from '../../docs/decisions.js';

export const MARKDOWN_GLOBS = ['**/*.md', '**/*.markdown'];
const DECISIONS_FILE = 'DECISIONS.md';

/** A path without the slashes it ends with. */
export function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

/** Files read at once, so a large repository doesn't run out of file handles. */
const BATCH = 64;

/** A file of the checkout, or undefined when it isn't there (deleted in a working tree). */
export async function readText(ctx: CheckContext, file: string): Promise<string | undefined> {
  try {
    return await readFile(join(ctx.root, file), 'utf8');
  } catch {
    return undefined;
  }
}

/** A tool config Talos rendered: its text is Talos's, not the project's. */
function isGenerated(text: string): boolean {
  const head = text.slice(0, 600).split('\n', 3);
  return (
    (head[0] ?? '').includes(GENERATED_MARKER) ||
    head.some((line) => line.trimStart().startsWith(`"//": "${GENERATED_MARKER}`))
  );
}

/** Blanks `CLAUDE.md`'s kit block, Talos's own text, keeping every line where it was. */
function withoutKitBlock(text: string): string {
  const begin = text.indexOf(KIT_BEGIN);
  const end = begin === -1 ? -1 : text.indexOf(KIT_END, begin);
  if (end === -1) return text;
  const stop = end + KIT_END.length;
  return (
    text.slice(0, begin) + text.slice(begin, stop).replaceAll(/[^\n]/g, ' ') + text.slice(stop)
  );
}

/** The project's own text in each file, skipping missing and generated files. */
export async function readOwnTexts(
  ctx: CheckContext,
  files: readonly string[],
): Promise<DocText[]> {
  const docs: DocText[] = [];
  for (let start = 0; start < files.length; start += BATCH) {
    const batch = files.slice(start, start + BATCH);
    const texts = await Promise.all(batch.map((file) => readText(ctx, file)));
    for (const [index, text] of texts.entries()) {
      const file = batch[index];
      if (file === undefined || text === undefined || isGenerated(text)) continue;
      docs.push({ file, text: withoutKitBlock(text) });
    }
  }
  return docs;
}

/** `DECISIONS.md` and every brief: where decisions are defined. */
export function decisionFiles(ctx: ApplyContext): string[] {
  const briefs = withoutTrailingSlashes(ctx.config.docs.briefs);
  return ctx.facts.matching(DECISIONS_FILE, `${briefs}/**/*.md`);
}

/** The texts of `DECISIONS.md` and the briefs, read once per run. */
export async function decisionTexts(ctx: CheckContext): Promise<DocText[]> {
  return ctx.memo('docs/decision-texts', () => readOwnTexts(ctx, decisionFiles(ctx)));
}
