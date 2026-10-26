import { describe, expect, it } from 'vitest';
import { strykerWrapper } from './stryker.js';
import { vitestArgs } from './vitest.js';

describe('vitestArgs', () => {
  it('runs with JUnit and LCOV into scratch, leaving the excluded directories out', () => {
    expect(
      vitestArgs({
        junit: '/s/junit.xml',
        coverageDir: '/s/coverage',
        excluded: ['e2e', 'test/db'],
        coverage: true,
      }),
    ).toEqual([
      'run',
      '--reporter=junit',
      '--outputFile=/s/junit.xml',
      '--passWithNoTests',
      '--allowOnly=false',
      '--exclude',
      'e2e/**',
      '--exclude',
      'test/db/**',
      '--coverage.enabled',
      '--coverage.provider=v8',
      '--coverage.reporter=lcovonly',
      '--coverage.reportsDirectory=/s/coverage',
      '--coverage.reportOnFailure',
    ]);
  });

  it('switches coverage off and names the files of a rerun', () => {
    const args = vitestArgs({
      junit: '/s/j.xml',
      coverageDir: '/s/c',
      excluded: [],
      coverage: false,
      files: ['src/a.test.ts'],
    });
    expect(args.slice(-2)).toEqual(['--coverage.enabled=false', 'src/a.test.ts']);
  });
});

describe('strykerWrapper', () => {
  it('narrows the base to the files and writes only the JSON report', () => {
    const text = strykerWrapper('file:///r/stryker.config.mjs', ['src/a.ts'], '/s/mutation.json');
    expect(text).toContain('import base from "file:///r/stryker.config.mjs";');
    expect(text).toContain('mutate: ["src/a.ts"],');
    expect(text).toContain("reporters: ['json'],");
    expect(text).toContain('jsonReporter: { fileName: "/s/mutation.json" },');
  });
});
