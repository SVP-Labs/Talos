import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { sentence } from './lint.js';
import {
  type ApplyContext,
  type Check,
  type CheckContext,
  EngineError,
  skip,
  APPLIES,
} from '../../../core/check.js';
import type { Finding } from '../../../core/finding.js';
import { componentFiles, rootOf, stripSlashes } from '../files.js';
import { type NodeTool, installedPackage, binScript, runTool, tail } from '../node.js';

const PLAYWRIGHT_CONFIG = /(?:^|\/)playwright\.config\.[cm]?[jt]s$/;

/** A `tests.full` path run by Playwright, and the config that runs it (repository-relative). */
export type Suite = { readonly path: string; readonly config: string };

function holds(dir: string, path: string): boolean {
  return dir === '.' || path === dir || path.startsWith(`${dir}/`);
}

/**
 * `tests.full` paths under the component with a Playwright config in them or in a directory
 * above them (within the component): the nearest config runs the suite.
 */
export function playwrightSuites(ctx: ApplyContext): Suite[] {
  const root = rootOf(ctx.component);
  const files = componentFiles(ctx);
  const configs = files.filter((file) => PLAYWRIGHT_CONFIG.test(file));
  return ctx.config.tests.full
    .map((path) => stripSlashes(path))
    .filter((path) => holds(root, path))
    .flatMap((path): Suite[] => {
      const nearest = configs
        .filter((config) => holds(posix.dirname(config), path))
        .sort((a, b) => b.length - a.length)[0];
      return nearest === undefined ? [] : [{ path, config: nearest }];
    });
}

/** Reads the suite's files: is it Playwright's, and does any of it use axe? */
export async function suiteImports(
  ctx: CheckContext,
  suite: Suite,
): Promise<{ playwright: boolean; axe: boolean }> {
  const files = componentFiles(ctx).filter((file) => holds(suite.path, file));
  const texts = await Promise.all(
    files.map((file) => readFile(join(ctx.root, file), 'utf8').catch(() => '')),
  );
  return {
    playwright: texts.some((text) => text.includes('@playwright/test')),
    axe: texts.some((text) => text.includes('@axe-core/playwright')),
  };
}

const failure = z.union([
  z.string(),
  z.looseObject({ message: z.string().optional(), '#text': z.string().optional() }),
]);
const testcase = z.looseObject({
  name: z.string(),
  classname: z.string().optional(),
  failure: z.array(failure).optional(),
  error: z.array(failure).optional(),
});
const junit = z.looseObject({
  testsuites: z.looseObject({
    testsuite: z.array(z.looseObject({ testcase: z.array(testcase).optional() })).optional(),
  }),
});

export type Failed = {
  readonly name: string;
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
};

const AT = /^(\S+?):(\d+):\d+\b/;

/** The failure's summary (where it failed) and its body (Playwright's report of the error). */
function failureOf(entry: z.infer<typeof testcase>): { at: string; body: string } | undefined {
  const first = entry.failure?.[0] ?? entry.error?.[0];
  if (first === undefined) return undefined;
  if (typeof first === 'string') return { at: first, body: first };
  return { at: first.message ?? '', body: first['#text'] ?? first.message ?? '' };
}

/** The error line of the body, or its first line. */
export function errorLine(body: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  return lines.find((line) => line.startsWith('Error')) ?? lines.find(Boolean) ?? '';
}

function failedCase(entry: z.infer<typeof testcase>): Failed[] {
  const failure = failureOf(entry);
  if (failure === undefined) return [];
  const [, file = entry.classname, line] = AT.exec(failure.at.trim()) ?? [];
  return [
    {
      name: entry.name,
      message: sentence(errorLine(failure.body)),
      ...(file === undefined ? {} : { file }),
      ...(line === undefined ? {} : { line: Number(line) }),
    },
  ];
}

/** The failed test cases of a Playwright JUnit report. */
export function parseJunitFailures(xml: string): Failed[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) => ['testsuite', 'testcase', 'failure', 'error'].includes(name),
  });
  const parsed = junit.safeParse(parser.parse(xml));
  if (!parsed.success) {
    throw new EngineError('the Playwright JUnit report is not one Talos can read');
  }
  return (parsed.data.testsuites.testsuite ?? []).flatMap((suite) =>
    (suite.testcase ?? []).flatMap((entry) => failedCase(entry)),
  );
}

/** A spec path the report gives (relative to Playwright's test directory) as a tracked file. */
function trackedSpec(
  ctx: ApplyContext,
  suite: Suite,
  file: string | undefined,
): string | undefined {
  if (file === undefined) return undefined;
  const normalised = file.replaceAll('\\', '/');
  return componentFiles(ctx).find(
    (tracked) =>
      holds(suite.path, tracked) && (tracked === normalised || tracked.endsWith(`/${normalised}`)),
  );
}

export function failureFindings(
  ctx: ApplyContext,
  suite: Suite,
  failed: readonly Failed[],
): Finding[] {
  return failed.map((test) => {
    const spec = trackedSpec(ctx, suite, test.file);
    const message = `The end-to-end test "${test.name}" fails: ${test.message}`;
    return spec === undefined
      ? { rule: 'playwright/failed', message, key: `${suite.path} ${test.name}` }
      : { rule: 'playwright/failed', message, location: { file: spec, line: test.line ?? 1 } };
  });
}

async function playwright(ctx: CheckContext): Promise<NodeTool> {
  for (const name of ['@playwright/test', 'playwright']) {
    const pkg = await installedPackage(ctx, name);
    const script = pkg === undefined ? undefined : binScript(pkg, 'playwright');
    if (script !== undefined) return { name: 'playwright', script };
  }
  throw new EngineError('@playwright/test is not installed: add it to the devDependencies');
}

async function runSuite(ctx: CheckContext, suite: Suite, index: number): Promise<Finding[]> {
  const tool = await playwright(ctx);
  const cwd = posix.dirname(suite.config);
  const report = join(ctx.scratch, `playwright-${index}.xml`);
  const filter = posix.relative(cwd, suite.path);
  const args = ['test', '--config', posix.basename(suite.config), '--reporter=junit'];
  const result = await runTool(ctx, tool, filter === '' ? args : [...args, filter], {
    cwd: join(ctx.root, cwd),
    env: { PLAYWRIGHT_JUNIT_OUTPUT_FILE: report, PLAYWRIGHT_JUNIT_OUTPUT_NAME: report },
    timeoutMs: 60 * 60 * 1000,
  });
  const xml = await readFile(report, 'utf8').catch(() => undefined);
  if (xml === undefined) {
    throw new EngineError(`playwright exited ${result.code}:\n${tail(result)}`);
  }
  const failed = parseJunitFailures(xml);
  if (result.code !== 0 && failed.length === 0) {
    throw new EngineError(`playwright exited ${result.code} with no failed test:\n${tail(result)}`);
  }
  return failureFindings(ctx, suite, failed);
}

function noAxe(suite: Suite): Finding {
  return {
    rule: 'e2e/no-axe',
    message: `No file of the end-to-end suite in ${suite.path} uses @axe-core/playwright; check each screen with axe.`,
    key: `e2e/no-axe ${suite.path}`,
    location: { file: suite.config, line: 1 },
  };
}

async function run(ctx: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const [index, suite] of playwrightSuites(ctx).entries()) {
    const imports = await suiteImports(ctx, suite);
    if (!imports.playwright) continue;
    if (!imports.axe) findings.push(noAxe(suite));
    findings.push(...(await runSuite(ctx, suite, index)));
  }
  return findings;
}

export const e2eCheck: Check = {
  id: 'ts/e2e',
  tier: 'head',
  scope: 'component',
  langs: ['ts'],
  title: 'Playwright end-to-end tests, with axe',
  applies: (ctx) =>
    playwrightSuites(ctx).length > 0
      ? APPLIES
      : skip('no tests.full path holds a Playwright suite'),
  run,
};
