import { describe, expect, it } from 'vitest';
import { isDue, onDefaultBranch } from './schedule.js';

const MONDAY = new Date('2026-10-26T03:17:00Z');
const TUESDAY = new Date('2026-10-27T03:17:00Z');
const SUNDAY_LATE = new Date('2026-10-25T23:59:00Z');

describe('isDue', () => {
  it('runs daily jobs on every scheduled run', () => {
    expect(isDue('daily', 'schedule', TUESDAY)).toBe(true);
  });

  it('runs weekly jobs on Mondays, UTC', () => {
    expect(isDue('weekly', 'schedule', MONDAY)).toBe(true);
    expect(isDue('weekly', 'schedule', TUESDAY)).toBe(false);
    expect(isDue('weekly', 'schedule', SUNDAY_LATE)).toBe(false);
  });

  it('runs everything on a manual dispatch', () => {
    expect(isDue('weekly', 'workflow_dispatch', TUESDAY)).toBe(true);
    expect(isDue('daily', 'workflow_dispatch', TUESDAY)).toBe(true);
  });

  it('runs nothing on other events', () => {
    expect(isDue('daily', 'issues', MONDAY)).toBe(false);
  });
});

describe('onDefaultBranch', () => {
  it('is true on the default branch, or when either side is unknown', () => {
    expect(onDefaultBranch('refs/heads/main', 'main')).toBe(true);
    expect(onDefaultBranch(undefined, 'main')).toBe(true);
    expect(onDefaultBranch('refs/heads/x', undefined)).toBe(true);
  });

  it('is false for a dispatch from another branch or a tag', () => {
    expect(onDefaultBranch('refs/heads/T-12', 'main')).toBe(false);
    expect(onDefaultBranch('refs/tags/v1.0.0', 'main')).toBe(false);
  });
});
