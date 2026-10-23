import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { parseDoctests } from './doctests.js';
import { junitXml, withFiles } from './junit.js';

/** Recorded from cargo-nextest 0.9.148's JUnit output, trimmed. */
const NEXTEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="talos" tests="3" skipped="0" failures="1" errors="0">
    <testsuite name="demo-core" tests="2" skipped="0" errors="0" failures="1">
        <testcase name="quiet::tests::night_is_quiet" classname="demo-core" time="0.042"/>
        <testcase name="quiet::tests::noon_is_quiet" classname="demo-core" time="0.160">
            <failure message="thread &apos;quiet::tests::noon_is_quiet&apos; (20435) panicked at core/src/quiet.rs:20:9" type="test failure with exit code 101">assertion failed</failure>
        </testcase>
    </testsuite>
    <testsuite name="demo-core::api" tests="1" skipped="0" errors="0" failures="0">
        <testcase name="adds" classname="demo-core::api" time="0.082"/>
    </testsuite>
</testsuites>
`;

/** Recorded from `cargo test --doc -- --color never` on Rust 1.97, backtrace trimmed. */
const DOCTESTS = `
running 3 tests
test core/src/quiet.rs - quiet::loud (line 31) ... ignored
test core/src/quiet.rs - quiet::loud (line 27) ... ok
test core/src/lib.rs - documented (line 33) ... FAILED

failures:

---- core/src/lib.rs - documented (line 33) stdout ----
Test executable failed (exit status: 101).

stderr:

thread 'main' (12468) panicked at /tmp/doctest/bundle_2024.rs:6:1:
assertion \`left == right\` failed
  left: 3
 right: 4
stack backtrace:
   0: __rustc::rust_begin_unwind
             at /rustc/2d8144b/library/std/src/panicking.rs:689:5
note: Some details are omitted, run with \`RUST_BACKTRACE=full\` for a verbose backtrace.



failures:
    core/src/lib.rs - documented (line 33)

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.08s
`;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

describe('withFiles', () => {
  it('adds the file each test case is in', () => {
    const xml = withFiles(NEXTEST, ({ binary, name }) =>
      binary === 'demo-core' && name.startsWith('quiet::') ? 'core/src/quiet.rs' : undefined,
    );
    expect(xml).toContain('<testcase file="core/src/quiet.rs" name="quiet::tests::night_is_quiet"');
    expect(xml).toContain('<testcase file="core/src/quiet.rs" name="quiet::tests::noon_is_quiet"');
    expect(xml).toContain('<testcase name="adds" classname="demo-core::api"');
    expect(() => parser.parse(xml) as unknown).not.toThrow();
  });
});

describe('parseDoctests', () => {
  it('reads each doctest’s outcome, file and failure', () => {
    expect(parseDoctests(DOCTESTS)).toEqual([
      {
        name: 'core/src/quiet.rs - quiet::loud (line 31)',
        classname: 'doctests',
        file: 'core/src/quiet.rs',
        skipped: true,
      },
      {
        name: 'core/src/quiet.rs - quiet::loud (line 27)',
        classname: 'doctests',
        file: 'core/src/quiet.rs',
      },
      {
        name: 'core/src/lib.rs - documented (line 33)',
        classname: 'doctests',
        file: 'core/src/lib.rs',
        failure: 'assertion `left == right` failed',
      },
    ]);
  });
});

describe('junitXml', () => {
  it('writes cases JUnit readers understand, escaped', () => {
    const xml = junitXml('doctests', [
      { name: 'a <b> & "c"', classname: 'doctests', file: 'src/lib.rs' },
      { name: 'b', classname: 'doctests', file: 'src/lib.rs', failure: "it's broken" },
      { name: 'c', classname: 'doctests', file: 'src/lib.rs', skipped: true },
    ]);
    const parsed = parser.parse(xml) as {
      testsuites: { failures: string; testsuite: { testcase: { name: string; file: string }[] } };
    };
    expect(parsed.testsuites.failures).toBe('1');
    expect(parsed.testsuites.testsuite.testcase.map((c) => c.name)).toEqual([
      'a <b> & "c"',
      'b',
      'c',
    ]);
    expect(xml).toContain('<failure message="it&apos;s broken"/>');
  });
});
