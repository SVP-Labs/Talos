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

// Windows may give a long path in its extended-length form, `\\?\C:\...` or `\\?\UNC\server\...`
// (jscpd reports it with forward slashes), which names the same file as `C:\...` or
// `\\server\...`; `node:path` parses neither form as the path it names.
const EXTENDED_LENGTH_UNC = /^(?:\\\\\?\\|\/\/\?\/)UNC[\\/]/i;
const EXTENDED_LENGTH = /^(?:\\\\\?\\|\/\/\?\/)/;

// Windows treats a drive letter case-insensitively, so `realpath` and jscpd may each give it in
// a different case for the same directory; nothing past the colon is case-insensitive this way.
const DRIVE_LETTER = /^[A-Za-z]:/;

/** A path in plain form with forward slashes and an upper-case drive letter. */
function comparable(path: string): string {
  const plain = path
    .replace(EXTENDED_LENGTH_UNC, '//')
    .replace(EXTENDED_LENGTH, '')
    .replaceAll('\\', '/');
  return DRIVE_LETTER.test(plain) ? plain.slice(0, 1).toUpperCase() + plain.slice(1) : plain;
}

/**
 * jscpd reports a file under the root it was given in the form the OS returned for that root, so
 * stripping the root as a string prefix is enough. `node:path` would make the result depend on
 * the host: it parses a drive-rooted path only on Windows, and resolves there against the current
 * drive.
 */
function toFragment(raw: z.infer<typeof fragment>, root: string): Fragment {
  const name = comparable(raw.name);
  const prefix = `${comparable(root).replace(/\/$/, '')}/`;
  const local = name.startsWith(prefix) ? name.slice(prefix.length) : name;
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
