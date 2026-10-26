import { describe, expect, it } from 'vitest';
import { errorLine, failureFindings, parseJunitFailures, playwrightSuites } from './e2e.js';
import { parseConfig } from '../../../config/load.js';
import { repoFacts } from '../../../repo/facts.js';

/** Recorded from @playwright/test 1.56.1 --reporter=junit, one test failing. */
const RECORDED = `<testsuites id="" name="" tests="2" failures="1" skipped="0" errors="0" time="0.74">
<testsuite name="home.spec.ts" timestamp="2026-10-23T11:46:10.340Z" hostname="" tests="2" failures="1" skipped="0" time="0.018" errors="0">
<testcase name="adds up" classname="home.spec.ts" time="0.013">
</testcase>
<testcase name="fails on purpose" classname="home.spec.ts" time="0.005">
<failure message="home.spec.ts:7:1 fails on purpose" type="FAILURE">
<![CDATA[  home.spec.ts:7:1 › fails on purpose ─────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 2
]]>
</failure>
</testcase>
</testsuite>
</testsuites>`;

function context(yml: string, files: readonly string[]) {
  const config = parseConfig(yml);
  const component = config.components[0];
  return {
    facts: repoFacts(files, []),
    config,
    side: 'alone' as const,
    tiers: ['head' as const],
    ...(component === undefined ? {} : { component }),
  };
}

describe('playwrightSuites', () => {
  const yml =
    'name: T\nprefix: T\ncomponents: [{ lang: ts }]\ntests: { full: [apps/web/e2e, apps/hub/test/db] }\n';

  it('finds the nearest Playwright config for each tests.full path', () => {
    const ctx = context(yml, [
      'apps/web/playwright.config.ts',
      'apps/web/e2e/home.spec.ts',
      'apps/hub/test/db/a.test.ts',
    ]);
    expect(playwrightSuites(ctx)).toEqual([
      { path: 'apps/web/e2e', config: 'apps/web/playwright.config.ts' },
    ]);
  });

  it('finds none without a Playwright config', () => {
    expect(playwrightSuites(context(yml, ['apps/web/e2e/home.spec.ts']))).toEqual([]);
  });
});

describe('parseJunitFailures', () => {
  it('reads the failed tests with where they failed and the error', () => {
    expect(parseJunitFailures(RECORDED)).toEqual([
      {
        name: 'fails on purpose',
        file: 'home.spec.ts',
        line: 7,
        message: 'Error: expect(received).toBe(expected) // Object.is equality',
      },
    ]);
  });

  it('reads a passing report as no failure', () => {
    expect(
      parseJunitFailures(
        '<testsuites><testsuite name="a"><testcase name="ok"/></testsuite></testsuites>',
      ),
    ).toEqual([]);
  });

  it('takes the error line, or else the first line', () => {
    expect(errorLine('  a › b\n\n  Error: boom\n')).toBe('Error: boom');
    expect(errorLine('\n timed out\n')).toBe('timed out');
  });
});

describe('failureFindings', () => {
  const yml = 'name: T\nprefix: T\ncomponents: [{ lang: ts }]\ntests: { full: [e2e] }\n';
  const ctx = context(yml, ['playwright.config.ts', 'e2e/home.spec.ts']);
  const suite = { path: 'e2e', config: 'playwright.config.ts' };

  it('places a failure at its test in the tracked spec', () => {
    const [failed] = parseJunitFailures(RECORDED);
    expect(failed && failureFindings(ctx, suite, [failed])).toEqual([
      {
        rule: 'playwright/failed',
        message:
          'The end-to-end test "fails on purpose" fails: Error: expect(received).toBe(expected) // Object.is equality',
        location: { file: 'e2e/home.spec.ts', line: 7 },
      },
    ]);
  });

  it('keys a failure it cannot place by suite and test', () => {
    expect(failureFindings(ctx, suite, [{ name: 'lost', message: 'x' }])).toMatchObject([
      { rule: 'playwright/failed', key: 'e2e lost' },
    ]);
  });
});
