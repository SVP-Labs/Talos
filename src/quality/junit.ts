import { posix, win32 } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { firstLine } from './text.js';
import { EngineError } from '../core/check.js';

export type TestStatus = 'passed' | 'failed' | 'errored' | 'skipped';

/** One `<testcase>` as the report has it. */
export type JunitCase = {
  readonly name: string;
  readonly classname?: string;
  /** The test's file as the report names it: relative to the report's base, or absolute. */
  readonly file?: string;
  readonly line?: number;
  readonly status: TestStatus;
  /** The first line of the failure, error or skip message, clipped. */
  readonly message?: string;
};

const LISTS = new Set(['testsuite', 'testcase', 'failure', 'error', 'skipped']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
  isArray: (name) => LISTS.has(name),
});

const outcome = z.union([
  z.string(),
  z.looseObject({ '#text': z.string().optional(), '@_message': z.string().optional() }),
]);

const testcase = z.looseObject({
  '@_name': z.string().default(''),
  '@_classname': z.string().optional(),
  '@_file': z.string().optional(),
  '@_line': z.string().optional(),
  failure: z.array(outcome).optional(),
  error: z.array(outcome).optional(),
  skipped: z.array(outcome).optional(),
});

const suite = z.looseObject({
  '@_file': z.string().optional(),
  testcase: z.array(z.union([z.literal(''), testcase])).optional(),
  testsuite: z.array(z.unknown()).optional(),
});

const document = z.looseObject({
  testsuites: z.union([z.literal(''), z.looseObject({ testsuite: z.array(z.unknown()).optional() })]).optional(),
  testsuite: z.array(z.unknown()).optional(),
});

type Outcome = z.infer<typeof outcome>;
type Testcase = z.infer<typeof testcase>;

function messageOf(outcomes: readonly Outcome[] | undefined): string | undefined {
  const first = outcomes?.[0];
  if (first === undefined) return undefined;
  const text = typeof first === 'string' ? first : (first['@_message'] ?? first['#text'] ?? '');
  const line = firstLine(text);
  return line === '' ? undefined : line;
}

function statusOf(test: Testcase): TestStatus {
  if (test.error !== undefined) return 'errored';
  if (test.failure !== undefined) return 'failed';
  return test.skipped === undefined ? 'passed' : 'skipped';
}

/** A trailing `:<line>` on a class name (busted writes one) is the test's line, not its name. */
function splitLine(classname: string | undefined): { classname?: string; line?: number } {
  if (classname === undefined) return {};
  const match = /^(.*):(\d+)$/.exec(classname);
  if (match?.[1] === undefined) return { classname };
  return { classname: match[1], line: Number(match[2]) };
}

function lineOf(attribute: string | undefined, fallback: number | undefined): number | undefined {
  const line = attribute === undefined ? Number.NaN : Number.parseInt(attribute, 10);
  return Number.isInteger(line) ? line : fallback;
}

function toCase(test: Testcase, suiteFile: string | undefined): JunitCase {
  const status = statusOf(test);
  const { classname, line } = splitLine(test['@_classname']);
  const file = test['@_file'] ?? suiteFile;
  const found = lineOf(test['@_line'], line);
  const message = messageOf(test.error ?? test.failure ?? test.skipped);
  return {
    name: test['@_name'],
    status,
    ...(classname === undefined || classname === '' ? {} : { classname }),
    ...(file === undefined || file === '' ? {} : { file }),
    ...(found === undefined ? {} : { line: found }),
    ...(message === undefined ? {} : { message }),
  };
}

function suiteCases(node: unknown, inherited: string | undefined): JunitCase[] {
  if (node === '') return [];
  const parsed = suite.safeParse(node);
  if (!parsed.success) throw new EngineError('a JUnit <testsuite> has an unexpected shape');
  const file = parsed.data['@_file'] ?? inherited;
  const own = (parsed.data.testcase ?? []).flatMap((test) =>
    test === '' ? [] : [toCase(test, file)],
  );
  const nested = (parsed.data.testsuite ?? []).flatMap((child) => suiteCases(child, file));
  return [...own, ...nested];
}

/**
 * Every `<testcase>` of a JUnit XML report, nested suites included, with its status: an
 * `<error>` makes it errored, a `<failure>` failed, a `<skipped>` skipped.
 */
export function parseJunit(xml: string): JunitCase[] {
  let raw: unknown;
  try {
    raw = parser.parse(xml);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineError(`a JUnit report is not XML: ${firstLine(reason)}`);
  }
  const parsed = document.safeParse(raw);
  const root = parsed.success ? parsed.data : undefined;
  if (root === undefined || (root.testsuites === undefined && root.testsuite === undefined)) {
    throw new EngineError('a JUnit report has neither <testsuites> nor <testsuite>');
  }
  const suites =
    root.testsuites === undefined || root.testsuites === ''
      ? (root.testsuite ?? [])
      : (root.testsuites.testsuite ?? []);
  return suites.flatMap((node) => suiteCases(node, undefined));
}

const SOURCE = /\.(?:[cm]?[jt]sx?|py|php|lua|rs)$/i;

/** The test's file: the report's `file`, or a class name that is a path (Vitest writes one). */
export function caseFile(test: JunitCase): string | undefined {
  if (test.file !== undefined) return test.file;
  return test.classname !== undefined && SOURCE.test(test.classname) ? test.classname : undefined;
}

function comparable(text: string): string {
  return text.toLowerCase().replaceAll(/[/\\._]/g, '.');
}

/**
 * What the class name adds to the file: nothing when it only restates the file (`src/a.test.ts`,
 * `tests.test_a` for `tests/test_a.py`, `Tests.Unit.ATest` for `tests/Unit/ATest.php`), the class
 * when it names one inside the file's module (`TestA` of `tests.test_a.TestA`), otherwise itself.
 */
export function classPart(classname: string | undefined, file: string | undefined): string | undefined {
  if (classname === undefined || file === undefined) return classname;
  const name = comparable(classname);
  const path = comparable(file.replace(/\.[^./\\]+$/, ''));
  if (name === comparable(file)) return undefined;
  const segments = path.split('.');
  for (let start = 0; start < segments.length; start += 1) {
    const suffix = segments.slice(start).join('.');
    if (suffix === '') continue;
    if (name === suffix) return undefined;
    if (name.startsWith(`${suffix}.`) && name.length === classname.length) {
      return classname.slice(suffix.length + 1);
    }
  }
  return classname;
}

/**
 * A test's identity across runs and commits: its repository-relative file when known, what its
 * class name adds, and its name, joined by `::`, as pytest names tests.
 */
export function testId(
  test: JunitCase,
  reportFile: string | undefined,
  repoFile: string | undefined,
): string {
  const scope = classPart(test.classname, reportFile ?? repoFile);
  const portable =
    reportFile === undefined || posix.isAbsolute(reportFile) || win32.isAbsolute(reportFile)
      ? undefined
      : reportFile;
  return [repoFile ?? portable, scope, test.name]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('::');
}
