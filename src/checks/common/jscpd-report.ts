import { z } from 'zod';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

const fragment = z.object({
  name: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

const report = z.object({
  duplicates: z.array(
    z.object({
      tokens: z.number().int().nonnegative(),
      firstFile: fragment,
      secondFile: fragment,
    }),
  ),
});

type Fragment = { readonly file: string; readonly start: number; readonly end: number };

// Windows resolves long paths to `\\?\C:\...` (jscpd reports it `//?/C:/...`), a prefix that
// `node:path` does not parse as the drive-rooted path it names, so `relative` cannot strip it.
const EXTENDED_LENGTH_PREFIX = /^(?:\\\\\?\\|\/\/\?\/)/;

function withoutExtendedLengthPrefix(raw: string): string {
  return raw.replace(EXTENDED_LENGTH_PREFIX, '');
}

// Windows treats a drive letter case-insensitively, so `realpath` and jscpd may each give it in
// a different case for the same directory; nothing past the colon is case-insensitive this way.
const DRIVE_LETTER = /^[A-Za-z]:/;

function withUppercaseDriveLetter(path: string): string {
  return DRIVE_LETTER.test(path) ? path.slice(0, 1).toUpperCase() + path.slice(1) : path;
}

/**
 * jscpd always reports a file under the root it was given, in whatever separator and drive or
 * UNC form the OS returned for that root, so stripping that same string as a prefix is enough —
 * no need for `node:path`, whose `isAbsolute`/`relative` resolve a path lacking a drive letter
 * against the current drive, a guess that depends on the machine running this and not on the
 * path itself.
 */
function toFragment(raw: z.infer<typeof fragment>, root: string): Fragment {
  const name = withoutExtendedLengthPrefix(raw.name).replaceAll('\\', '/');
  const base = withoutExtendedLengthPrefix(root).replaceAll('\\', '/').replace(/\/$/, '');
  const prefix = `${withUppercaseDriveLetter(base)}/`;
  const matches = withUppercaseDriveLetter(name).startsWith(prefix);
  const local = matches ? name.slice(prefix.length) : name;
  const file = local.replace(/^\.\//, '');
  const start = Math.max(1, raw.start);
  return { file, start, end: Math.max(start, raw.end) };
}

/** Which of two fragments comes first, by path and then line, so the choice never varies. */
function ordered(a: Fragment, b: Fragment): readonly [Fragment, Fragment] {
  const first = a.file === b.file ? a.start <= b.start : a.file < b.file;
  return first ? [a, b] : [b, a];
}

function where(other: Fragment, later: Fragment): string {
  const lines = `lines ${other.start}-${other.end}`;
  return other.file === later.file ? `${lines} of this file` : `${other.file} ${lines}`;
}

function cloneFinding(tokens: number, a: Fragment, b: Fragment): Finding {
  const [earlier, later] = ordered(a, b);
  return {
    rule: 'jscpd/clone',
    message:
      `Lines ${later.start}-${later.end} repeat ${where(earlier, later)} (${tokens} tokens): ` +
      'keep one copy and share it.',
    location: { file: later.file, line: later.start, endLine: later.end },
  };
}

/**
 * One finding per repeated fragment in jscpd's JSON report, on the later of the two copies by
 * path and line, naming the other. Paths are made relative to `root`.
 */
export function cloneFindings(text: string, root: string): Finding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EngineError('jscpd wrote a report that is not JSON');
  }
  const parsed = report.safeParse(raw);
  if (!parsed.success) {
    throw new EngineError(`jscpd's report has an unknown shape: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.duplicates.map((duplicate) =>
    cloneFinding(
      duplicate.tokens,
      toFragment(duplicate.firstFile, root),
      toFragment(duplicate.secondFile, root),
    ),
  );
}
