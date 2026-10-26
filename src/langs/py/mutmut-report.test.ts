import { describe, expect, it } from 'vitest';
import { firstChange, MUTMUT_REPORT, mutmutStatus, parseMutmutReport } from './mutmut-report.js';
import { EngineError } from '../../core/check.js';

// `mutmut show` diffs recorded from mutmut 3.8.0; line numbers count from the function's text.
const METHOD = [
  '--- src/m/core.py',
  '+++ src/m/core.py',
  '@@ -2,6 +2,6 @@',
  ' @staticmethod',
  ' def grow(size: int) -> int:',
  '     """Grow."""',
  '-    if size > 10:',
  '+    if size >= 10:',
  '         return size',
  '     return size + 1',
].join('\n');

const FUNCTION = [
  '--- src/lenient/limits.py',
  '+++ src/lenient/limits.py',
  '@@ -1,3 +1,3 @@',
  ' def over(level: int, limit: int) -> bool:',
  '     """Say whether a level is over a limit."""',
  '-    return level > limit',
  '+    return level >= limit',
  '',
].join('\n');

describe('firstChange', () => {
  it('finds the first changed line and what replaced it', () => {
    expect(firstChange(METHOD)).toEqual({
      offset: 5,
      original: 'if size > 10:',
      replacement: 'if size >= 10:',
    });
    expect(firstChange(FUNCTION)).toEqual({
      offset: 3,
      original: 'return level > limit',
      replacement: 'return level >= limit',
    });
  });

  it('reads a removed line with nothing in its place, and no diff at all', () => {
    expect(firstChange('@@ -4,2 +4,1 @@\n a = 1\n-b = 2\n c = 3\n')).toEqual({
      offset: 5,
      original: 'b = 2',
      replacement: '',
    });
    expect(firstChange('')).toBeUndefined();
  });
});

describe('mutmutStatus', () => {
  it('maps mutmut’s words onto Talos’s', () => {
    expect(mutmutStatus('survived')).toBe('survived');
    expect(mutmutStatus('no tests')).toBe('no-coverage');
    expect(mutmutStatus('caught by type check')).toBe('killed');
    expect(mutmutStatus('suspicious')).toBe('timeout');
    expect(mutmutStatus('not checked')).toBe('ignored');
    expect(mutmutStatus('something new')).toBe('error');
  });
});

describe('parseMutmutReport', () => {
  it('places each mutant in its file through its function’s first line', () => {
    const report = {
      format: MUTMUT_REPORT,
      mutants: [
        {
          name: 'm.core.xǁBoxǁgrow__mutmut_1',
          file: 'src/m/core.py',
          status: 'survived',
          functionLine: 24,
          diff: METHOD,
        },
        {
          name: 'm.core.xǁBoxǁ__init____mutmut_1',
          file: 'src/m/core.py',
          status: 'killed',
          functionLine: 20,
          diff: '',
        },
      ],
    };
    expect(parseMutmutReport(JSON.stringify(report))).toEqual([
      {
        file: 'src/m/core.py',
        line: 28,
        mutator: 'm.core.xǁBoxǁgrow__mutmut_1',
        original: 'if size > 10:',
        replacement: 'if size >= 10:',
        status: 'survived',
      },
      {
        file: 'src/m/core.py',
        line: 20,
        mutator: 'm.core.xǁBoxǁ__init____mutmut_1',
        original: '',
        replacement: '',
        status: 'killed',
      },
    ]);
  });

  it('refuses anything but its own report', () => {
    expect(() => parseMutmutReport('nope')).toThrow(EngineError);
    expect(() => parseMutmutReport('{"format": "other", "mutants": []}')).toThrow(EngineError);
  });
});
