import { listed } from './conditions.js';
import { isTestPath } from './testfiles.js';
import type { PullFile } from './types.js';
import { type FileChange, parseDiff } from '../repo/changes.js';

/**
 * Test integrity, from a pull request's diff alone: deleted test files, fewer test cases, new skip
 * markers, fewer assertions. It never runs the code, so it judges lines, per language.
 */

/** A line counts when any of a kind's patterns matches it. */
type Patterns = {
  readonly cases: readonly RegExp[];
  readonly skips: readonly RegExp[];
  readonly asserts: readonly RegExp[];
  /** Whether tests live beside code (Rust's `#[test]`), so source files count too. */
  readonly inline?: boolean;
};

const TS: Patterns = {
  cases: [/^\s*(?:it|test)(?:\.\w+)*\s*[(`]/],
  skips: [
    /\b(?:it|test|describe|suite)\.(?:skip|todo|only|fails|skipIf|runIf)\b/,
    /\bx(?:it|test|describe)\s*\(/,
    /\bf(?:it|describe)\s*\(/,
  ],
  asserts: [/\bexpect(?:\.\w+)?\s*\(/, /\bassert(?:\.\w+)*\s*\(/, /\.should\b/],
};

const PY: Patterns = {
  cases: [/^\s*(?:async\s+)?def\s+test\w*\s*\(/],
  skips: [
    /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
    /(?:^|[^\w.])pytest\.(?:skip|xfail)\s*\(/,
    /@unittest\.(?:skip\w*|expectedFailure)\b/,
    /\.skipTest\s*\(/,
  ],
  asserts: [/^\s*assert\b/, /\.assert\w*\s*\(/, /(?:^|[^\w.])pytest\.raises\s*\(/],
};

const PHP: Patterns = {
  cases: [
    /^\s*(?:public\s+)?function\s+test\w*\s*\(/,
    /#\[Test\]/,
    /@test\b/,
    /^\s*(?:it|test)\s*\(/,
  ],
  skips: [/markTest(?:Skipped|Incomplete)\s*\(/, /->(?:skip|todo)\s*\(/, /#\[Skip/],
  asserts: [/(?:\$this->|self::|static::)assert\w*\s*\(/, /\bexpect\s*\(/, /->to[A-Z]\w*\s*\(/],
};

const LUA: Patterns = {
  cases: [/^\s*it\s*\(/],
  skips: [/\bpending\s*\(/, /#skip\b/],
  asserts: [/\bassert(?:\.\w+)*\s*\(/],
};

const RUST: Patterns = {
  cases: [/^\s*#\[(?:\w+::)*test\b/],
  skips: [/^\s*#\[ignore\b/],
  asserts: [/\b(?:debug_)?assert(?:_eq|_ne|_matches)?!\s*\(/],
  inline: true,
};

const GO: Patterns = {
  cases: [/^\s*func\s+Test\w*\s*\(/],
  skips: [/\bt\.Skip(?:f|Now)?\s*\(/],
  asserts: [/\bt\.(?:Errorf?|Fatalf?|Fail|FailNow)\s*\(/, /\b(?:assert|require)\.\w+\s*\(/],
};

const BY_EXTENSION: Readonly<Record<string, Patterns>> = {
  ts: TS,
  tsx: TS,
  mts: TS,
  cts: TS,
  js: TS,
  jsx: TS,
  mjs: TS,
  cjs: TS,
  py: PY,
  php: PHP,
  lua: LUA,
  rs: RUST,
  go: GO,
};

/** The patterns for a file, or `undefined` for a language Talos reads no tests in. */
export function patternsFor(path: string): Patterns | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : BY_EXTENSION[path.slice(dot + 1).toLowerCase()];
}

type IntegrityCounts = {
  readonly casesAdded: number;
  readonly casesRemoved: number;
  readonly skipsAdded: number;
  readonly assertsAdded: number;
  readonly assertsRemoved: number;
};

export type Integrity = {
  readonly flagged: boolean;
  /** One short line per problem; empty when nothing was flagged. */
  readonly reasons: readonly string[];
  readonly counts: IntegrityCounts;
};

function count(lines: readonly string[], patterns: readonly RegExp[]): number {
  return lines.filter((line) => patterns.some((pattern) => pattern.test(line))).length;
}

const MODES: Readonly<Record<string, string>> = {
  added: 'new file mode 100644\n',
  removed: 'deleted file mode 100644\n',
};

/** A file's own patch, with the header `parseDiff` reads its paths and status from. */
export function fileChange(file: PullFile): FileChange | undefined {
  const old = file.previousPath ?? file.path;
  const mode = MODES[file.status] ?? '';
  const text = `diff --git a/${old} b/${file.path}\n${mode}${file.patch ?? ''}\n`;
  return [...parseDiff(text).files.values()][0];
}

function countsOf(files: readonly PullFile[]): IntegrityCounts {
  const totals = {
    casesAdded: 0,
    casesRemoved: 0,
    skipsAdded: 0,
    assertsAdded: 0,
    assertsRemoved: 0,
  };
  for (const file of files) {
    const patterns = patternsFor(file.path) ?? patternsFor(file.previousPath ?? '');
    const change = file.patch === undefined ? undefined : fileChange(file);
    if (patterns === undefined || change === undefined) continue;
    const testFile = isTestPath(file.path) || isTestPath(file.previousPath ?? '');
    if (!testFile && patterns.inline !== true) continue;
    totals.casesAdded += count(change.addedText, patterns.cases);
    totals.casesRemoved += count(change.removedText, patterns.cases);
    totals.skipsAdded += count(change.addedText, patterns.skips);
    if (!testFile) continue;
    totals.assertsAdded += count(change.addedText, patterns.asserts);
    totals.assertsRemoved += count(change.removedText, patterns.asserts);
  }
  return totals;
}

/** A test file deleted, or renamed to a path that is no test. */
function deletedTests(files: readonly PullFile[]): string[] {
  return files
    .filter((file) =>
      file.status === 'removed'
        ? isTestPath(file.path)
        : file.previousPath !== undefined &&
          isTestPath(file.previousPath) &&
          !isTestPath(file.path),
    )
    .map((file) => file.previousPath ?? file.path);
}

/** Files with changes whose patch GitHub left out: too large to show, so unreadable here. */
function unreadable(files: readonly PullFile[]): string[] {
  return files.filter((file) => file.patch === undefined && file.changes > 0).map((f) => f.path);
}

/**
 * Test integrity for a pull request's files. `complete` is false when GitHub listed fewer files
 * than the PR changes, so some went unread.
 */
export function testIntegrity(files: readonly PullFile[], complete = true): Integrity {
  const counts = countsOf(files);
  const reasons: string[] = [];
  const deleted = deletedTests(files);
  if (deleted.length > 0) reasons.push(`deletes test files: ${listed(deleted)}`);
  if (counts.casesRemoved > counts.casesAdded) {
    reasons.push(`removes ${counts.casesRemoved} test cases and adds ${counts.casesAdded}`);
  }
  if (counts.skipsAdded > 0) reasons.push(`adds ${counts.skipsAdded} skip markers`);
  if (counts.assertsRemoved > counts.assertsAdded) {
    reasons.push(`removes ${counts.assertsRemoved} assertions and adds ${counts.assertsAdded}`);
  }
  const missing = unreadable(files);
  if (missing.length > 0) reasons.push(`no diff to read for ${listed(missing)}`);
  if (!complete) reasons.push('GitHub listed only part of the changed files');
  return { flagged: reasons.length > 0, reasons, counts };
}
