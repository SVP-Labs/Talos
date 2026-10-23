import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type FileLines,
  parseClover,
  parseCobertura,
  parseLcov,
  type RawFile,
  toLineCoverage,
} from './coverage.js';
import { caseFile, parseJunit, testId } from './junit.js';
import { luacovLines, parseLuacovStats } from './luacov.js';
import { inComponent, inRepository } from './paths.js';
import type { CoverageFormat, Report } from './protocol.js';
import type { TestResult } from './verdicts.js';
import { type CheckContext, EngineError } from '../core/check.js';

/** A report the tool was asked to write; an unreadable one is an engine error. */
export async function readReport(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new EngineError(`the ${what} report ${path} could not be read`);
  }
}

/** Every test case of the run's JUnit reports, files made repository-relative. */
export async function readTests(
  ctx: CheckContext,
  reports: readonly Report[],
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const report of reports) {
    for (const test of parseJunit(await readReport(report.path, 'JUnit'))) {
      const reportFile = caseFile(test);
      const file =
        reportFile === undefined ? undefined : inRepository(ctx.root, report.base, reportFile);
      results.push({
        id: testId(test, reportFile, file),
        name: test.name,
        status: test.status,
        ...(file === undefined ? {} : { file }),
        ...(test.line === undefined ? {} : { line: test.line }),
        ...(test.message === undefined ? {} : { message: test.message }),
      });
    }
  }
  return results;
}

type Locate = (path: string, sources: readonly string[]) => string | undefined;

/**
 * Where a report's file is in the repository: tried against each source directory and then the
 * report's base; only a tracked, not excluded file of the component counts.
 */
function locator(ctx: CheckContext, base: string): Locate {
  const tracked = new Set(ctx.facts.files);
  return (path, sources) => {
    const candidates = [...sources.map((source) => resolve(base, source, path)), path];
    for (const candidate of candidates) {
      const file = inRepository(ctx.root, base, candidate);
      if (file !== undefined && tracked.has(file) && inComponent(ctx.component, file)) return file;
    }
    return undefined;
  };
}

async function luacovFiles(ctx: CheckContext, text: string, locate: Locate): Promise<RawFile[]> {
  const files: RawFile[] = [];
  for (const [name, hits] of parseLuacovStats(text)) {
    const file = locate(name, []);
    if (file === undefined) continue;
    const source = await readReport(join(ctx.root, file), 'luacov source');
    files.push({ path: file, hits: luacovLines(source, hits) });
  }
  return files;
}

/** The run's coverage report as lines per repository-relative file of the component. */
export async function readCoverage(
  ctx: CheckContext,
  report: Report & { readonly format: CoverageFormat },
): Promise<Map<string, FileLines>> {
  const text = await readReport(report.path, `${report.format} coverage`);
  const locate = locator(ctx, report.base);
  switch (report.format) {
    case 'lcov':
      return toLineCoverage(parseLcov(text), locate);
    case 'cobertura':
      return toLineCoverage(parseCobertura(text), locate);
    case 'clover':
      return toLineCoverage(parseClover(text), locate);
    case 'luacov':
      return toLineCoverage({ files: await luacovFiles(ctx, text, locate), sources: [] }, (p) => p);
  }
}
