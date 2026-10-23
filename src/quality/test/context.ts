import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../config/load.js';
import type { CheckContext, Component, Memo, Tier } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import { escapeXml } from '../../core/xml.js';
import { exec } from '../../exec/exec.js';
import type { ChangeSet } from '../../repo/changes.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, noTools, tempRepo } from '../../testing/engine.js';
import type { RawTestRun, TestRequest, TestRunner } from '../protocol.js';

type ContextOptions = {
  /** Files written into the checkout and tracked. */
  readonly files?: Readonly<Record<string, string>>;
  /** Tracked without being written. */
  readonly tracked?: readonly string[];
  readonly yml?: string;
  readonly component?: Component;
  readonly side?: CheckContext['side'];
  readonly tiers?: readonly Tier[];
  readonly changes?: ChangeSet;
};

export type TestContext = CheckContext & {
  /** Every key the checks asked the memo for, in order. */
  readonly memoKeys: string[];
};

function isPromise<T>(value: unknown): value is Promise<T> {
  return value instanceof Promise;
}

function testMemo(keys: string[]): Memo {
  const cache = new Map<string, unknown>();
  return async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
    keys.push(key);
    const known = cache.get(key);
    if (isPromise<T>(known)) return known;
    const started = compute();
    cache.set(key, started);
    return started;
  };
}

/** A checkout in a temporary directory and a context for one check run on it. */
export async function testContext(options: ContextOptions = {}): Promise<TestContext> {
  const files = options.files ?? {};
  const root = await tempRepo(files);
  const config = parseConfig(options.yml ?? MINIMAL_CONFIG);
  const tracked = [...Object.keys(files), ...(options.tracked ?? [])];
  const memoKeys: string[] = [];
  return {
    root,
    sha: '0'.repeat(40),
    exec,
    tools: noTools,
    scratch: await mkdtemp(join(tmpdir(), 'talos-quality-')),
    log: silentLogger,
    os: 'linux',
    facts: repoFacts(tracked, config.exclude),
    config,
    side: options.side ?? 'alone',
    tiers: options.tiers ?? ['commit', 'head'],
    memo: testMemo(memoKeys),
    memoKeys,
    ...(options.component === undefined ? {} : { component: options.component }),
    ...(options.changes === undefined ? {} : { changes: options.changes }),
  };
}

/** A runner that answers each run from `answer` and remembers what it was asked. */
export function scriptedRunner(
  answer: (request: TestRequest, call: number) => RawTestRun | Promise<RawTestRun>,
): TestRunner & { readonly requests: TestRequest[] } {
  const requests: TestRequest[] = [];
  return {
    requests,
    run: async (_ctx, request) => {
      requests.push(request);
      return answer(request, requests.length);
    },
  };
}

type CaseSpec = {
  readonly name: string;
  readonly file?: string;
  readonly status?: 'passed' | 'failed' | 'errored' | 'skipped';
  readonly message?: string;
};

function caseXml(spec: CaseSpec): string {
  const file = spec.file === undefined ? '' : ` file="${escapeXml(spec.file)}"`;
  const message = escapeXml(spec.message ?? 'boom');
  const inner: Record<NonNullable<CaseSpec['status']>, string> = {
    passed: '',
    failed: `<failure message="${message}">trace</failure>`,
    errored: `<error message="${message}">trace</error>`,
    skipped: '<skipped/>',
  };
  return `<testcase name="${escapeXml(spec.name)}"${file}>${inner[spec.status ?? 'passed']}</testcase>`;
}

/** A JUnit report holding one suite of these cases. */
export function junitXml(cases: readonly CaseSpec[]): string {
  return `<?xml version="1.0"?>\n<testsuites><testsuite name="t">${cases.map(caseXml).join('')}</testsuite></testsuites>\n`;
}
