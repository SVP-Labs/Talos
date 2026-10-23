import type { CheckContext } from '../core/check.js';

/**
 * What a language pack provides so the shared quality checks (tests, flaky tests, coverage,
 * mutation) work the same in every language. A runner only runs its tool and says where the
 * reports are; reading them, rerunning failures and judging coverage is shared.
 */

export type CoverageFormat = 'lcov' | 'cobertura' | 'clover' | 'luacov';

export type TestRequest = {
  /**
   * `commit`: every test outside `talos.yml`'s `tests.full` (the per-commit tier);
   * `all`: every test, at a PR's head. A project with no `tests.full` runs all of them in both.
   */
  readonly suite: 'commit' | 'all';
  readonly coverage: boolean;
  /** For the one rerun of failures: only these test files, repository-relative. */
  readonly files?: readonly string[];
};

export type Report = {
  /** Absolute path of the report file. */
  readonly path: string;
  /** Absolute directory the report's own relative paths are relative to. */
  readonly base: string;
};

export type RawTestRun = {
  readonly exitCode: number;
  /** The tool's combined output, kept for an engine error's message only. */
  readonly output: string;
  /** JUnit XML reports, one per run of the tool. */
  readonly junit: readonly Report[];
  readonly coverage?: Report & { readonly format: CoverageFormat };
};

export type TestRunner = {
  run(ctx: CheckContext, request: TestRequest): Promise<RawTestRun>;
};

export type MutationFormat = 'stryker' | 'mutmut' | 'infection' | 'cargo-mutants';

export type MutationRunner = {
  /** Mutates only these source files (repository-relative) and reports every mutant's fate. */
  run(
    ctx: CheckContext,
    files: readonly string[],
  ): Promise<Report & { readonly format: MutationFormat }>;
};
