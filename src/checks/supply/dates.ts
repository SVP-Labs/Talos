import type { ExceptionEntry } from '../../config/schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The longest a young release may be allowed for. */
export const MAX_ALLOW_DAYS = 7;

/** The minimum age of a release, in hours. */
export const MIN_AGE_HOURS = 24;

/** A UTC calendar date, `YYYY-MM-DD`. */
export function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * An entry expires on its date: from that day on it no longer applies, as osv-scanner's
 * `ignoreUntil` stops ignoring at the start of the day.
 */
export function expired(entry: ExceptionEntry, now: Date): boolean {
  return entry.expires <= isoDay(now);
}

/** Whether an entry's expiry lies more than `days` days after today. */
export function beyond(entry: ExceptionEntry, now: Date, days: number): boolean {
  return entry.expires > isoDay(new Date(now.getTime() + days * DAY_MS));
}

/** Whole hours from `then` to `now`, never negative. */
export function hoursBetween(then: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / (60 * 60 * 1000)));
}

export const youngerThanADay = (published: Date, now: Date): boolean =>
  now.getTime() - published.getTime() < MIN_AGE_HOURS * 60 * 60 * 1000;
