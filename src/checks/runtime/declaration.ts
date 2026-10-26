import type { Runtime } from './runtimes.js';
import { isExactRelease } from './versions.js';

/**
 * - `exact`: one release, which the feeds can judge;
 * - `floating`: a cycle, a range, a moving tag such as `lts`, or nothing at all;
 * - `minimum`: the lowest release a project supports (composer.json's platform), never a pin.
 */
type Exactness = 'exact' | 'floating' | 'minimum';

/** One place a repository declares the runtime it ships or builds with. */
export type Declaration = {
  readonly runtime: Runtime;
  /** Repository-relative, forward slashes. */
  readonly file: string;
  /** 1-based: the line that sets the version. */
  readonly line: number;
  readonly endLine?: number;
  /** As the file writes it, build arguments resolved: `php:8.4-fpm`, `lts/*`, `go1.23.4`. */
  readonly written: string;
  /** The release it names (`8.4.26`, `8.4`, `8.5.0RC2`); absent when it names none (`latest`). */
  readonly version?: string;
  readonly exactness: Exactness;
};

export type Place = {
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
};

/** A pin: exact when the version is one release, floating otherwise. */
export function pinned(
  runtime: Runtime,
  place: Place,
  written: string,
  version: string | undefined,
): Declaration {
  const exactness = version !== undefined && isExactRelease(version) ? 'exact' : 'floating';
  return {
    runtime,
    ...place,
    written,
    ...(version === undefined ? {} : { version }),
    exactness,
  };
}

/** The 1-based line of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') line += 1;
  }
  return line;
}

function withoutComment(line: string): string {
  const hash = line.indexOf('#');
  return hash < 0 ? line : line.slice(0, hash);
}

/** Non-empty lines with `#` comments removed, each with its 1-based line number. */
export function meaningfulLines(text: string): { readonly text: string; readonly line: number }[] {
  return text
    .split(/\r?\n/)
    .map((raw, index) => ({ text: withoutComment(raw).trim(), line: index + 1 }))
    .filter((entry) => entry.text !== '');
}
