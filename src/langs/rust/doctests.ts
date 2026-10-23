import type { Case } from './junit.js';

const RESULT = /^test (.+) \.\.\. (ok|FAILED|ignored\b.*)$/;
const NOISE = /^(Test executable failed|stderr:|stdout:|stack backtrace:|note: |\d+: |at )/;

/** The lines of each failure's `---- <name> stdout ----` block. */
function failureBlocks(lines: readonly string[]): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const header = /^---- (.+) stdout ----$/.exec(line);
    if (header?.[1] !== undefined) {
      current = [];
      blocks.set(header[1], current);
    } else if (line === 'failures:') current = undefined;
    else current?.push(line.trim());
  }
  return blocks;
}

/** What went wrong, in a line: the panic's message or the compiler's first error. */
export function failureMessage(block: readonly string[] | undefined): string {
  const lines = (block ?? []).filter((line) => line !== '' && !NOISE.test(line));
  const panic = lines.findIndex((line) => line.includes('panicked at'));
  const picked = panic >= 0 ? lines.slice(panic + 1, panic + 2) : lines.slice(0, 1);
  const text = picked.join(' ').trim() || 'the doctest failed';
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/**
 * `cargo test --doc`'s plain output as test cases. libtest's JUnit output isn't stable, so the
 * runner reads its `test <name> ... ok` lines; a doctest's name starts with its file, relative
 * to the workspace root, which is the case's `file` until the caller places it.
 */
export function parseDoctests(stdout: string): Case[] {
  const lines = stdout.split(/\r?\n/);
  const blocks = failureBlocks(lines);
  return lines.flatMap((line): Case[] => {
    const match = RESULT.exec(line);
    const name = match?.[1];
    const outcome = match?.[2];
    if (name === undefined || outcome === undefined) return [];
    const file = name.split(' - ')[0] ?? name;
    const base = { name, classname: 'doctests', file };
    if (outcome === 'FAILED') return [{ ...base, failure: failureMessage(blocks.get(name)) }];
    return [outcome === 'ok' ? base : { ...base, skipped: true }];
  });
}
