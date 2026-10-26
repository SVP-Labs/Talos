import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderRustfmt } from './configs.js';
import { isInside, realRelativeTo, rustFiles } from './paths.js';
import { type Bound, cargo, failed } from './run.js';
import { componentDir, inComponent } from '../../core/component.js';
import type { Finding } from '../../core/finding.js';

/** The lines of one file rustfmt would change, on the file's current side. */
export type Unformatted = {
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
};

type Hunk = { file: string; next: number; first: number; last: number };

function finishHunk(hunk: Hunk | undefined, found: Map<string, Unformatted>): void {
  if (hunk === undefined || hunk.first === 0) return;
  const known = found.get(hunk.file);
  found.set(hunk.file, {
    file: hunk.file,
    line: Math.min(known?.line ?? hunk.first, hunk.first),
    endLine: Math.max(known?.endLine ?? hunk.last, hunk.last),
  });
}

function mark(hunk: Hunk, line: number): void {
  if (hunk.first === 0) hunk.first = line;
  hunk.last = Math.max(hunk.last, line);
}

/**
 * `rustfmt --check`'s diffs: a `Diff in <file>:<line>:` header per hunk, then context (` `),
 * removed (`-`) and added (`+`) lines. Added lines mark the line they go before.
 */
export function parseRustfmtCheck(stdout: string): Unformatted[] {
  const found = new Map<string, Unformatted>();
  let hunk: Hunk | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const header = /^Diff in (.+):(\d+):$/.exec(line);
    if (header?.[1] !== undefined) {
      finishHunk(hunk, found);
      hunk = { file: header[1], next: Number(header[2]), first: 0, last: 0 };
    } else if (hunk !== undefined && line.startsWith('-')) {
      mark(hunk, hunk.next);
      hunk.next += 1;
    } else if (hunk !== undefined && line.startsWith('+')) {
      mark(hunk, Math.max(1, hunk.next - 1));
    } else if (hunk !== undefined && line.startsWith(' ')) {
      hunk.next += 1;
    }
  }
  finishHunk(hunk, found);
  return [...found.values()];
}

/** Files rustfmt couldn't parse; rust/types reports their syntax errors. */
export function unparsable(stderr: string): string[] {
  return stderr.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('--> ')) return [];
    const at = trimmed.slice(4);
    const position = /:\d+:\d+$/.exec(at);
    return position === null ? [] : [at.slice(0, position.index)];
  });
}

/** The finding's message: which lines rustfmt would write differently. */
export function unformattedMessage(u: Unformatted): string {
  return u.line === u.endLine
    ? `Line ${String(u.line)} isn't formatted the way rustfmt writes it.`
    : `Lines ${String(u.line)} to ${String(u.endLine)} aren't formatted the way rustfmt writes them.`;
}

/**
 * `cargo fmt --all --check` with Talos's rustfmt.toml passed explicitly, so neither a
 * `.rustfmt.toml` nor a nested `rustfmt.toml` changes what the gate expects.
 */
export async function format(ctx: Bound): Promise<Finding[]> {
  const config = join(ctx.scratch, 'rustfmt', 'rustfmt.toml');
  await mkdir(join(ctx.scratch, 'rustfmt'), { recursive: true });
  await writeFile(config, renderRustfmt(''));
  const args = ['fmt', '--all', '--check', '--', '--color', 'never', '--config-path', config];
  const result = await cargo(ctx, args);
  const changes = parseRustfmtCheck(result.stdout);
  if (result.code !== 0 && changes.length === 0 && unparsable(result.stderr).length === 0) {
    throw failed('cargo fmt', result);
  }
  const dir = componentDir(ctx);
  const own = new Set(rustFiles(ctx));
  const found = await Promise.all(
    changes.map(async (u): Promise<Finding[]> => {
      const file = await realRelativeTo(ctx.root, dir, u.file);
      const local = inComponent(ctx.component.root, file);
      if (!isInside(file) || local === undefined || !own.has(local)) return [];
      return [
        {
          rule: 'rustfmt/format',
          message: unformattedMessage(u),
          location: { file, line: u.line, endLine: u.endLine },
        },
      ];
    }),
  );
  return found.flat();
}
