import type { RenderContext } from '../../../core/pack.js';
import { excludedHere, rootOf } from '../files.js';

/** A JavaScript string literal in single quotes, as Prettier writes it. */
export function quote(text: string): string {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll("'", String.raw`\'`);
  return `'${escaped}'`;
}

/** Array entries one per line at the given indent, each followed by a comma. */
export function lines(items: readonly string[], indent: string): string {
  return items.map((item) => `${indent}${item},\n`).join('');
}

/** `talos.yml`'s `exclude` entries under the rendered component, relative to its root. */
export function excludes(ctx: RenderContext): string[] {
  return excludedHere(ctx.config.exclude, rootOf(ctx.component));
}

/** An `exclude` entry as a glob covering a directory's contents, or the entry itself. */
export function excludeGlobs(entry: string): string[] {
  return /[*?[{]/.test(entry) ? [entry] : [entry, `${entry}/**`];
}
