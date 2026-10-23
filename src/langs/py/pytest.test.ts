import { describe, expect, it } from 'vitest';
import { coverageRc, pytestArgs } from './pytest.js';

const BASE = [
  '-p',
  'no:cacheprovider',
  '--rootdir=.',
  '--strict-markers',
  '-o',
  'strict_xfail=true',
  '-o',
  'junit_family=xunit1',
  '--junitxml=/scratch/junit.xml',
  '-q',
  '--color=no',
];

describe('pytestArgs', () => {
  const ctx = { root: 'svc', full: ['svc/tests/e2e', 'web/e2e'], junit: '/scratch/junit.xml' };

  it('leaves the full suite out of the per-commit run', () => {
    expect(pytestArgs({ suite: 'commit', coverage: false }, ctx)).toEqual([
      ...BASE,
      '--ignore=tests/e2e',
    ]);
  });

  it('runs every test at head, and only the given files on a rerun', () => {
    expect(pytestArgs({ suite: 'all', coverage: true }, ctx)).toEqual(BASE);
    expect(
      pytestArgs(
        { suite: 'commit', coverage: false, files: ['svc/tests/test_a.py', 'web/x.py'] },
        ctx,
      ),
    ).toEqual([...BASE, 'tests/test_a.py']);
  });
});

describe('coverageRc', () => {
  it('measures the component outside its tests, into the given data file', () => {
    const rc = coverageRc('/scratch/coverage.data');
    expect(rc).toContain('data_file = /scratch/coverage.data');
    expect(rc).toContain('source = .');
    expect(rc).toContain('    */test_*.py');
    expect(rc).toContain('    if TYPE_CHECKING:');
    expect(rc.split('\n')[0]).toBe('[run]');
  });
});
