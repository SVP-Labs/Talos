import type { MutationRunner, TestRunner } from './protocol.js';
import type { Check, Lang } from '../core/check.js';

/**
 * The shared test checks for a language: `<lang>/tests` (commit tier: the suite outside
 * `tests.full`, failures rerun once, flaky tests reported) and `<lang>/coverage` (head tier: every
 * test with coverage; lost coverage and changed lines under 90% covered).
 */
export function testChecks(_lang: Lang, _runner: TestRunner): Check[] {
  return [];
}

/** `<lang>/mutation` (head tier): the declared mutation paths a change touches. */
export function mutationChecks(_lang: Lang, _runner: MutationRunner): Check[] {
  return [];
}

export type {
  CoverageFormat,
  MutationFormat,
  MutationRunner,
  RawTestRun,
  Report,
  TestRequest,
  TestRunner,
} from './protocol.js';
