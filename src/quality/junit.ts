import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { firstLine } from './text.js';
import { parseXml } from './xml.js';
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

const LISTS = ['testsuite', 'testcase', 'failure', 'error', 'skipped'];

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
  '@_name': z.string().optional(),
  '@_file': z.string().optional(),
  testcase: z.array(z.union([z.literal(''), testcase])).optional(),
  testsuite: z.array(z.unknown()).optional(),
});

const document = z.looseObject({
  testsuites: z
    .union([
      z.literal(''),
      z.looseObject({
        '@_name': z.string().optional(),
        testsuite: z.array(z.unknown()).optional(),
      }),
    ])
    .optional(),
  testsuite: z.array(z.unknown()).optional(),
});

type Outcome = z.infer<typeof outcome>;
type Testcase = z.infer<typeof testcase>;

/** What a suite passes to its test cases. */
type Inherited = {
  readonly file: string | undefined;
  /** Added to a `line` attribute: pytest numbers lines from 0, every other tool from 1. */
  readonly offset: number;
};

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

function lineOf(test: Testcase, offset: number, fallback: number | undefined): number | undefined {
  const attribute = test['@_line'];
  const line = attribute === undefined ? Number.NaN : Number.parseInt(attribute, 10);
  return Number.isInteger(line) ? line + offset : fallback;
}

/** Pest names a test's file `path::test name`; the path is the file. */
function fileOf(attribute: string | undefined): string | undefined {
  return attribute?.split('::')[0];
}

function toCase(test: Testcase, inherited: Inherited): JunitCase {
  const status = statusOf(test);
  const { classname, line } = splitLine(test['@_classname']);
  const file = fileOf(test['@_file']) ?? inherited.file;
  const found = lineOf(test, inherited.offset, line);
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

function suiteCases(node: unknown, inherited: Inherited): JunitCase[] {
  if (node === '') return [];
  const parsed = suite.safeParse(node);
  if (!parsed.success) throw new EngineError('a JUnit <testsuite> has an unexpected shape');
  const here = { ...inherited, file: fileOf(parsed.data['@_file']) ?? inherited.file };
  const own = (parsed.data.testcase ?? []).flatMap((test) =>
    test === '' ? [] : [toCase(test, here)],
  );
  const nested = (parsed.data.testsuite ?? []).flatMap((child) => suiteCases(child, here));
  return [...own, ...nested];
}

const named = z.looseObject({ '@_name': z.string() });

/** pytest names its report's root `pytest tests`; older versions name its one suite `pytest`. */
function isPytest(rootName: string | undefined, suites: readonly unknown[]): boolean {
  if (rootName === 'pytest tests') return true;
  return suites.some((node) => named.safeParse(node).data?.['@_name'] === 'pytest');
}

/**
 * Every `<testcase>` of a JUnit XML report, nested suites included, with its status: an
 * `<error>` makes it errored, a `<failure>` failed, a `<skipped>` skipped.
 */
export function parseJunit(xml: string): JunitCase[] {
  const parsed = document.safeParse(parseXml(xml, 'JUnit', LISTS));
  if (!parsed.success) throw new EngineError('a JUnit report has an unexpected shape');
  const root = parsed.data;
  if (root.testsuites === undefined && root.testsuite === undefined) {
    throw new EngineError('a JUnit report has neither <testsuites> nor <testsuite>');
  }
  const wrapper = root.testsuites === '' ? undefined : root.testsuites;
  const suites = wrapper === undefined ? (root.testsuite ?? []) : (wrapper.testsuite ?? []);
  const offset = isPytest(wrapper?.['@_name'], suites) ? 1 : 0;
  return suites.flatMap((node) => suiteCases(node, { file: undefined, offset }));
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
export function classPart(
  classname: string | undefined,
  file: string | undefined,
): string | undefined {
  if (classname === undefined || file === undefined) return classname;
  const name = comparable(classname);
  if (name === comparable(file)) return undefined;
  const segments = comparable(file.replace(/\.[^./\\]+$/, '')).split('.');
  const suffixes = segments.map((_, start) => segments.slice(start).join('.'));
  for (const suffix of suffixes.filter((candidate) => candidate !== '')) {
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
