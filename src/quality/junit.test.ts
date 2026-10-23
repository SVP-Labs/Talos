import { describe, expect, it } from 'vitest';
import { caseFile, classPart, type JunitCase, parseJunit, testId } from './junit.js';
import { EngineError } from '../core/check.js';

// Recorded from Vitest 3 (`--reporter=junit`), trimmed.
const VITEST = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="4" failures="2" errors="0" time="0.01">
    <testsuite name="src/broken.test.ts" tests="1" failures="1" errors="0" skipped="0" time="0">
        <testcase classname="src/broken.test.ts" name="src/broken.test.ts" time="0">
            <failure message="Cannot find module &apos;./missing.js&apos; imported from /w/src/broken.test.ts" type="Error">
Error: Cannot find module &apos;./missing.js&apos;
 ❯ src/broken.test.ts:1:1
            </failure>
        </testcase>
    </testsuite>
    <testsuite name="src/sum.test.ts" tests="3" failures="1" errors="0" skipped="1" time="0.01">
        <testcase classname="src/sum.test.ts" name="sum &gt; adds" time="0.002">
        </testcase>
        <testcase classname="src/sum.test.ts" name="sum &gt; fails &lt;always&gt; &amp; &quot;quoted&quot;" time="0.006">
            <failure message="expected 3 to be 4 // Object.is equality" type="AssertionError">
AssertionError: expected 3 to be 4 // Object.is equality
            </failure>
        </testcase>
        <testcase classname="src/sum.test.ts" name="sum &gt; skipped one" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>
`;

// Recorded from pytest 8 with `-o junit_family=xunit1`, trimmed: `line` counts from 0.
const PYTEST = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="5" time="0.034"><testcase classname="tests.test_calc" name="test_add" file="tests/test_calc.py" line="5" time="0.000" /><testcase classname="tests.test_calc" name="test_fails" file="tests/test_calc.py" line="9" time="0.001"><failure message="assert 3 == 4&#10; +  where 3 = add(1, 2)">def test_fails():
&gt;       assert add(1, 2) == 4
tests/test_calc.py:11: AssertionError</failure></testcase><testcase classname="tests.test_calc" name="test_skipped" file="tests/test_calc.py" line="13" time="0.000"><skipped type="pytest.skip" message="not now">/w/tests/test_calc.py:14: not now</skipped></testcase><testcase classname="tests.test_calc.TestGroup" name="test_param[1]" file="tests/test_calc.py" line="22" time="0.000" /><testcase classname="tests.test_calc" name="test_errors" file="tests/test_calc.py" line="32" time="0.000"><error message="failed on setup with &quot;RuntimeError: fixture boom&quot;">@pytest.fixture
tests/test_calc.py:30: RuntimeError</error></testcase></testsuite></testsuites>`;

// Recorded from pytest 8's default (xunit2) report of a module that fails to import.
const PYTEST_COLLECTION = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="0" skipped="0" tests="1" time="0.176"><testcase classname="" name="tests.test_calc" time="0.000"><error message="collection failure">ImportError while importing test module '/w/tests/test_calc.py'.
E   ModuleNotFoundError: No module named 'pkg'</error></testcase></testsuite></testsuites>`;

// Recorded from Pest 3 (`--log-junit`): nested suites, and `file` as `path::test name`.
const PEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="/w/phpunit.xml" tests="2" assertions="2" errors="0" failures="1" skipped="0" time="0.01">
    <testsuite name="Unit" tests="2" assertions="2" errors="0" failures="1" skipped="0" time="0.01">
      <testsuite name="Tests\\Unit\\CalculatorTest" file="tests/Unit/CalculatorTest.php" tests="2" assertions="2" errors="0" failures="1" skipped="0" time="0.01">
        <testcase name="it adds" file="tests/Unit/CalculatorTest.php::it adds" class="Tests\\Unit\\CalculatorTest" classname="Tests.Unit.CalculatorTest" assertions="1" time="0.004"/>
        <testcase name="it fails" file="tests/Unit/CalculatorTest.php::it fails" class="Tests\\Unit\\CalculatorTest" classname="Tests.Unit.CalculatorTest" assertions="1" time="0.006">
          <failure type="PHPUnit\\Framework\\ExpectationFailedException">it failsFailed asserting that 3 is identical to 4.
at tests/Unit/CalculatorTest.php:12</failure>
        </testcase>
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>
`;

// Recorded from busted 2.3 (`-o junit`): the class name ends with the test's line.
const BUSTED = `<testsuites skip='1' tests='3' errors='1' failures='0' time='0.02'>
	<testsuite skip='1' tests='3' name='Run 1 of 1' timestamp='2026-10-23T12:35:11' time='0.01' failures='0' errors='1'>
		<testcase time='0.00' classname='spec.calc_spec_lua:4' name='calc adds'/>
		<testcase time='0.00' classname='spec/unit.name_other_spec_lua:2' name='dotted errors'>
			<error>spec/unit/name.other_spec.lua:3: boom
stack traceback:
	spec/unit/name.other_spec.lua:3: in function &lt;spec/unit/name.other_spec.lua:2&gt;
</error>
		</testcase>
		<testcase time='0.00' classname='spec/unit.name_other_spec_lua:5' name='dotted later'>
			<skipped/>
		</testcase>
	</testsuite>
</testsuites>
`;

// Recorded from cargo-nextest 0.9 (`[profile.x.junit]`): suites per binary, no files.
const NEXTEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="2" skipped="0" failures="0" errors="0" time="0.053">
    <testsuite name="demo-core" tests="1" skipped="0" errors="0" failures="0">
        <testcase name="quiet::tests::night_is_quiet" classname="demo-core" time="0.010"/>
    </testsuite>
    <testsuite name="demo-core::api" tests="1" skipped="0" errors="0" failures="0">
        <testcase name="adds" classname="demo-core::api" time="0.010"/>
    </testsuite>
</testsuites>
`;

describe('parseJunit', () => {
  it('reads Vitest: statuses, decoded names, the first line of each message', () => {
    expect(parseJunit(VITEST)).toEqual([
      {
        name: 'src/broken.test.ts',
        classname: 'src/broken.test.ts',
        status: 'failed',
        message: "Cannot find module './missing.js' imported from /w/src/broken.test.ts",
      },
      { name: 'sum > adds', classname: 'src/sum.test.ts', status: 'passed' },
      {
        name: 'sum > fails <always> & "quoted"',
        classname: 'src/sum.test.ts',
        status: 'failed',
        message: 'expected 3 to be 4 // Object.is equality',
      },
      { name: 'sum > skipped one', classname: 'src/sum.test.ts', status: 'skipped' },
    ]);
  });

  it('reads pytest, whose lines count from 0, and errors apart from failures', () => {
    const cases = parseJunit(PYTEST);
    expect(cases.map((test) => [test.name, test.status, test.line])).toEqual([
      ['test_add', 'passed', 6],
      ['test_fails', 'failed', 10],
      ['test_skipped', 'skipped', 14],
      ['test_param[1]', 'passed', 23],
      ['test_errors', 'errored', 33],
    ]);
    expect(cases[1]).toMatchObject({ file: 'tests/test_calc.py', message: 'assert 3 == 4' });
    expect(cases[4]?.message).toBe('failed on setup with "RuntimeError: fixture boom"');
  });

  it('reads an older pytest report by its suite’s name', () => {
    const older = '<testsuite name="pytest"><testcase name="t" file="a.py" line="0"/></testsuite>';
    expect(parseJunit(older)).toEqual([{ name: 't', file: 'a.py', line: 1, status: 'passed' }]);
  });

  it('reads a pytest collection error, which names no file or class', () => {
    expect(parseJunit(PYTEST_COLLECTION)).toEqual([
      {
        name: 'tests.test_calc',
        status: 'errored',
        message: 'collection failure',
      },
    ]);
  });

  it('reads Pest’s nested suites and its `path::name` files', () => {
    expect(parseJunit(PEST)).toEqual([
      {
        name: 'it adds',
        classname: 'Tests.Unit.CalculatorTest',
        file: 'tests/Unit/CalculatorTest.php',
        status: 'passed',
      },
      {
        name: 'it fails',
        classname: 'Tests.Unit.CalculatorTest',
        file: 'tests/Unit/CalculatorTest.php',
        status: 'failed',
        message: 'it failsFailed asserting that 3 is identical to 4.',
      },
    ]);
  });

  it('gives a test the file of the suite that holds it', () => {
    const xml =
      '<testsuites><testsuite name="s" file="tests/ATest.php"><testcase name="a"/></testsuite></testsuites>';
    expect(parseJunit(xml)).toEqual([{ name: 'a', file: 'tests/ATest.php', status: 'passed' }]);
  });

  it('reads busted, taking the line from the class name', () => {
    expect(parseJunit(BUSTED)).toEqual([
      { name: 'calc adds', classname: 'spec.calc_spec_lua', line: 4, status: 'passed' },
      {
        name: 'dotted errors',
        classname: 'spec/unit.name_other_spec_lua',
        line: 2,
        status: 'errored',
        message: 'spec/unit/name.other_spec.lua:3: boom',
      },
      {
        name: 'dotted later',
        classname: 'spec/unit.name_other_spec_lua',
        line: 5,
        status: 'skipped',
      },
    ]);
  });

  it('reads cargo-nextest', () => {
    expect(parseJunit(NEXTEST).map((test) => `${test.classname ?? ''} ${test.name}`)).toEqual([
      'demo-core quiet::tests::night_is_quiet',
      'demo-core::api adds',
    ]);
  });

  it('keeps a message from text alone, drops empty ones and empty elements', () => {
    const xml = [
      '<testsuite>',
      '<testcase name="a" classname="c:7" line="3"><failure>  \n  first\nsecond</failure></testcase>',
      '<testcase name="b" line="x"><failure message=""/></testcase>',
      '<testcase name="c"><failure type="AssertionError"/></testcase>',
      '<testcase classname=""/>',
      '<testcase/>',
      '</testsuite>',
    ].join('');
    expect(parseJunit(xml)).toEqual([
      { name: 'a', classname: 'c', line: 3, status: 'failed', message: 'first' },
      { name: 'b', status: 'failed' },
      { name: 'c', status: 'failed' },
      { name: '', status: 'passed' },
    ]);
  });

  it('reads reports with no tests', () => {
    expect(parseJunit('<testsuites/>')).toEqual([]);
    expect(parseJunit('<testsuites name="x"></testsuites>')).toEqual([]);
    expect(parseJunit('<testsuites><testsuite name="empty"></testsuite></testsuites>')).toEqual([]);
    expect(parseJunit('<testsuites><testsuite/></testsuites>')).toEqual([]);
  });

  it('throws an engine error for a report it cannot read', () => {
    expect(() => parseJunit('<testsuites><testsuite>')).toThrow(EngineError);
    expect(() => parseJunit('<testsuites>text</testsuites>')).toThrow(
      'a JUnit report has an unexpected shape',
    );
    expect(() => parseJunit('<results><test/></results>')).toThrow(
      'a JUnit report has neither <testsuites> nor <testsuite>',
    );
    expect(() => parseJunit('<testsuites><testsuite>text</testsuite></testsuites>')).toThrow(
      'a JUnit <testsuite> has an unexpected shape',
    );
  });
});

function junitCase(fields: Partial<JunitCase>): JunitCase {
  return { name: 't', status: 'passed', ...fields };
}

describe('caseFile', () => {
  it('takes the file, or a class name that is a source path', () => {
    expect(caseFile(junitCase({ file: 'a.py', classname: 'b.ts' }))).toBe('a.py');
    expect(caseFile(junitCase({ classname: 'src/sum.test.ts' }))).toBe('src/sum.test.ts');
    expect(caseFile(junitCase({ classname: 'tests.test_calc' }))).toBeUndefined();
    expect(caseFile(junitCase({}))).toBeUndefined();
  });
});

describe('classPart', () => {
  it('drops a class name that only restates the file', () => {
    expect(classPart('src/sum.test.ts', 'src/sum.test.ts')).toBeUndefined();
    expect(classPart('tests.test_calc', 'tests/test_calc.py')).toBeUndefined();
    expect(classPart('Tests.Unit.CalculatorTest', 'tests/Unit/CalculatorTest.php')).toBeUndefined();
    expect(classPart('test_calc', 'pkg/tests/test_calc.py')).toBeUndefined();
  });

  it('keeps the class inside the file’s module, or a class name unrelated to it', () => {
    expect(classPart('tests.test_calc.TestGroup', 'tests/test_calc.py')).toBe('TestGroup');
    expect(classPart('demo-core', 'src/lib.rs')).toBe('demo-core');
    expect(classPart('demo-core', undefined)).toBe('demo-core');
    expect(classPart(undefined, 'a.py')).toBeUndefined();
  });

  it('keeps a class name whose lower case changes its length', () => {
    expect(classPart('İ.TestX', 'i.py')).toBe('İ.TestX');
  });
});

describe('testId', () => {
  it('joins the repository file, what the class adds and the name, as pytest does', () => {
    const grouped = junitCase({ classname: 'tests.test_calc.TestGroup', name: 'test_inside' });
    expect(testId(grouped, 'tests/test_calc.py', 'api/tests/test_calc.py')).toBe(
      'api/tests/test_calc.py::TestGroup::test_inside',
    );
  });

  it('falls back on the report’s relative file, never an absolute one', () => {
    const test = junitCase({ classname: 'x', name: 'n' });
    expect(testId(test, 'tests/a.py', undefined)).toBe('tests/a.py::x::n');
    expect(testId(test, '/elsewhere/a.py', undefined)).toBe('x::n');
    expect(testId(test, 'C:\\elsewhere\\a.py', undefined)).toBe('x::n');
  });

  it('names a test by its class alone when no file is known', () => {
    expect(testId(junitCase({ classname: 'demo-core', name: 'adds' }), undefined, undefined)).toBe(
      'demo-core::adds',
    );
    expect(
      testId(junitCase({ classname: '', name: 'tests.test_calc' }), undefined, undefined),
    ).toBe('tests.test_calc');
  });
});
