import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  cycleOf,
  inCycle,
  isExactRelease,
  isRelease,
  leadingRelease,
  newest,
} from './versions.js';

describe('releases', () => {
  it('knows a release number from anything else', () => {
    expect(['8.4.26', '22', '1.99'].map(isRelease)).toEqual([true, true, true]);
    expect(['8.5.0RC2', 'lts/*', '', '1.', 'v22.1.0'].map(isRelease)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('takes three parts as exact', () => {
    expect(isExactRelease('8.4.26')).toBe(true);
    expect(isExactRelease('8.4')).toBe(false);
    expect(isExactRelease(['8', '4', '26', '1'].join('.'))).toBe(false);
    expect(isExactRelease('3.14.0rc1')).toBe(false);
  });

  it('orders numerically, a shorter version first on a tie', () => {
    expect(compareVersions('8.4.27', '8.4.9')).toBeGreaterThan(0);
    expect(compareVersions('8.4', '8.4.0')).toBeLessThan(0);
    expect(compareVersions('22.12.0', '22.12.0')).toBe(0);
    expect(newest(['8.4.9', '8.4.27', '8.4.10'])).toBe('8.4.27');
    expect(newest([])).toBeUndefined();
  });

  it('places a version in its most specific cycle', () => {
    expect(inCycle('8.4.26', '8.4')).toBe(true);
    expect(inCycle('8.41.0', '8.4')).toBe(false);
    expect(cycleOf('3.13.1', ['3.1', '3.13', '3'])).toBe('3.13');
    expect(cycleOf('22.12.0', ['24', '22', '20'])).toBe('22');
    expect(cycleOf('8.4', ['8.4', '8.3'])).toBe('8.4');
    expect(cycleOf('9.0.0', ['8.4'])).toBeUndefined();
  });

  it('reads the release that starts a text', () => {
    expect(leadingRelease('8.5.0RC2')).toBe('8.5.0');
    expect(leadingRelease('1.24rc1')).toBe('1.24');
    expect(leadingRelease('lts')).toBeUndefined();
  });
});
