import { describe, expect, it } from 'vitest';
import { coverageArgs, normalizeJunit, testPaths } from './pest.js';
import { parseConfig } from '../../config/load.js';
import { repoFacts } from '../../repo/facts.js';

// Recorded from Pest 5.3.3 (`--log-junit`), trimmed.
const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Tests\\LedgerTest" file="tests/LedgerTest.php" tests="2" failures="1">
    <testcase name="it adds" file="tests/LedgerTest.php::it adds" class="Tests\\LedgerTest" classname="Tests.LedgerTest" assertions="1" time="0.003879"/>
    <testcase name="it counts a refund twice" file="tests/LedgerTest.php::it counts a refund twice" class="Tests\\LedgerTest" classname="Tests.LedgerTest" assertions="1" time="0.003158">
      <failure type="PHPUnit\\Framework\\ExpectationFailedException">Failed asserting that -2 is identical to -4.</failure>
    </testcase>
  </testsuite>
</testsuites>`;

describe('normalizeJunit', () => {
  it("drops Pest's test name from each file attribute", () => {
    const fixed = normalizeJunit(JUNIT);
    expect(fixed).not.toContain('::');
    expect(fixed).toContain('<testcase name="it adds" file="tests/LedgerTest.php" class=');
    expect(fixed).toContain('<testsuite name="Tests\\LedgerTest" file="tests/LedgerTest.php"');
  });
});

const files = [
  'app/src/A.php',
  'app/tests/Unit/ATest.php',
  'app/tests/Slow/BTest.php',
  'app/tests/Pest.php',
];

function ctx(yml: string): Parameters<typeof testPaths>[0] {
  const config = parseConfig(
    `name: T\nprefix: T\ncomponents:\n  - { lang: php, root: app }\n${yml}`,
  );
  return {
    facts: repoFacts(files, []),
    component: config.components[0] ?? { lang: 'php', root: 'app', os: ['linux'] },
    config,
  };
}

describe('testPaths', () => {
  it('runs the whole suite unless tests.full names some of it', () => {
    expect(testPaths(ctx(''), { suite: 'commit', coverage: false })).toBeUndefined();
    expect(
      testPaths(ctx('tests: { full: [app/tests/Slow] }'), { suite: 'all', coverage: true }),
    ).toBeUndefined();
  });

  it('leaves tests.full out of the per-commit suite', () => {
    expect(
      testPaths(ctx('tests: { full: [app/tests/Slow/] }'), { suite: 'commit', coverage: false }),
    ).toEqual(['tests/Unit/ATest.php']);
  });

  it('reruns the files it is given, relative to the component', () => {
    expect(
      testPaths(ctx(''), { suite: 'commit', coverage: false, files: ['app/tests/Unit/ATest.php'] }),
    ).toEqual(['tests/Unit/ATest.php']);
  });
});

describe('coverageArgs', () => {
  it('measures every directory of shipped code, whatever phpunit.xml says', () => {
    expect(coverageArgs(ctx(''), '/s/clover.xml')).toEqual([
      '--coverage-clover',
      '/s/clover.xml',
      '--coverage-filter',
      'src',
    ]);
  });
});
