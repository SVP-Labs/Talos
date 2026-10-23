import type { FileLines } from './coverage.js';
import { changedLinesFinding, uncoveredFindings } from './lines.js';
import type { TestRunner } from './protocol.js';
import { FULL_SUITE, sharedSuite, type SuiteRun, testsRequest } from './suite.js';
import { testFindings } from './verdicts.js';
import { APPLIES, type Check, type CheckContext, type Lang } from '../core/check.js';
import type { Finding } from '../core/finding.js';

function identity(finding: Finding): string {
  return `${finding.rule}\0${finding.key ?? ''}`;
}

/**
 * The coverage run's test findings that `<lang>/tests` doesn't report in the same run: tests
 * only the full suite runs (`tests.full`), and different verdicts on the same test. Without the
 * commit tier in the run, all of them. If the per-commit run fails, its check reports why, and
 * this one reports its own findings.
 */
async function unreported(
  ctx: CheckContext,
  own: readonly Finding[],
  perCommit: () => Promise<SuiteRun>,
): Promise<readonly Finding[]> {
  if (own.length === 0 || !ctx.tiers.includes('commit')) return own;
  try {
    const theirs = new Set(testFindings((await perCommit()).verdicts).map(identity));
    return own.filter((finding) => !theirs.has(identity(finding)));
  } catch {
    return own;
  }
}

function coverageFindings(ctx: CheckContext, run: SuiteRun): Finding[] {
  const coverage = run.coverage ?? new Map<string, FileLines>();
  const changed =
    ctx.side === 'head' && ctx.changes !== undefined
      ? changedLinesFinding(coverage, ctx.changes)
      : undefined;
  return [...uncoveredFindings(coverage), ...(changed === undefined ? [] : [changed])];
}

/**
 * The shared test checks for a language: `<lang>/tests` (commit tier: the suite outside
 * `tests.full`, failures rerun once, flaky tests reported) and `<lang>/coverage` (head tier: every
 * test with coverage; lost coverage and changed lines under 90% covered).
 */
export function testChecks(lang: Lang, runner: TestRunner): Check[] {
  const tests: Check = {
    id: `${lang}/tests`,
    tier: 'commit',
    scope: 'component',
    langs: [lang],
    title: 'Tests',
    applies: () => APPLIES,
    run: async (ctx) =>
      testFindings((await sharedSuite(lang, runner, ctx, testsRequest(ctx))).verdicts),
  };
  const coverage: Check = {
    id: `${lang}/coverage`,
    tier: 'head',
    scope: 'component',
    langs: [lang],
    title: 'Coverage',
    applies: () => APPLIES,
    run: async (ctx) => {
      const run = await sharedSuite(lang, runner, ctx, FULL_SUITE);
      const perCommit = () => sharedSuite(lang, runner, ctx, testsRequest(ctx));
      const failures = await unreported(ctx, testFindings(run.verdicts), perCommit);
      return [...failures, ...coverageFindings(ctx, run)];
    },
  };
  return [tests, coverage];
}
