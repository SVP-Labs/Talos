import type { LineCoverage } from './coverage.js';
import { lineRanges } from './text.js';
import type { Finding } from '../core/finding.js';
import type { ChangeSet } from '../repo/changes.js';

/** A change's executable lines must be at least this share covered, in percent. */
export const CHANGED_LINES_FLOOR = 90;

/** How many uncovered changed lines the finding's message names. */
const LISTED = 10;

function byPath<T>(entries: Iterable<[string, T]>): [string, T][] {
  return [...entries].sort(([a], [b]) => a.localeCompare(b));
}

/** `coverage/uncovered` for each executable line no test ran; `lost` when the base covered it. */
export function uncoveredFindings(coverage: LineCoverage): Finding[] {
  return byPath(coverage).flatMap(([file, lines]) =>
    [...lines.executable]
      .filter((line) => !lines.covered.has(line))
      .sort((a, b) => a - b)
      .map((line): Finding => ({
        rule: 'coverage/uncovered',
        message: `No test runs line ${line}.`,
        location: { file, line },
        policy: 'lost',
      })),
  );
}

type Changed = { readonly total: number; readonly uncovered: readonly [string, number[]][] };

function changedLines(coverage: LineCoverage, changes: ChangeSet): Changed {
  let total = 0;
  const uncovered: [string, number[]][] = [];
  for (const [path, change] of byPath(changes.files)) {
    const lines = coverage.get(path);
    if (change.status === 'deleted' || lines === undefined) continue;
    const executable = change.added.flatMap((range) =>
      Array.from({ length: range.end - range.start + 1 }, (_, offset) => range.start + offset),
    );
    const counted = executable.filter((line) => lines.executable.has(line));
    total += counted.length;
    const missed = counted.filter((line) => !lines.covered.has(line)).sort((a, b) => a - b);
    if (missed.length > 0) uncovered.push([path, missed]);
  }
  return { total, uncovered };
}

/**
 * `coverage/changed-lines` when tests cover less than 90% of the executable lines the change
 * adds or edits; blocking whatever the base had, since the base can't have these lines.
 */
export function changedLinesFinding(
  coverage: LineCoverage,
  changes: ChangeSet,
): Finding | undefined {
  const { total, uncovered } = changedLines(coverage, changes);
  const missed = uncovered.flatMap(([file, lines]) => lines.map((line) => `${file}:${line}`));
  const covered = total - missed.length;
  if (total === 0 || covered * 100 >= total * CHANGED_LINES_FLOOR) return undefined;
  const percent = Math.floor((covered * 100) / total);
  const more = missed.length > LISTED ? ` and ${missed.length - LISTED} more` : '';
  return {
    rule: 'coverage/changed-lines',
    message:
      `Tests cover ${covered} of the ${total} executable lines this change adds or edits ` +
      `(${percent}%, ${CHANGED_LINES_FLOOR}% needed); uncovered: ` +
      `${missed.slice(0, LISTED).join(', ')}${more}.`,
    key: uncovered.map(([file, lines]) => `${file}:${lineRanges(lines)}`).join(' '),
    policy: 'always',
  };
}
