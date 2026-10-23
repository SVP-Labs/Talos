/**
 * The caller fires once a day ("17 3 * * *"); each scheduled job decides whether it is due.
 * Weekly jobs run on Mondays, UTC. A manual dispatch runs every scheduled job at once.
 */
export type Cadence = 'daily' | 'weekly';

const MONDAY = 1;

export function isDue(cadence: Cadence, event: string, now: Date): boolean {
  if (event === 'workflow_dispatch') return true;
  if (event !== 'schedule') return false;
  return cadence === 'daily' || now.getUTCDay() === MONDAY;
}

/**
 * Whether a scheduled or dispatched run is on the default branch. A manual dispatch can name any
 * branch, and its caller and checkout then come from there; when the payload doesn't say which
 * branch is the default, the run is taken to be on it.
 */
export function onDefaultBranch(
  ref: string | undefined,
  defaultBranch: string | undefined,
): boolean {
  if (ref === undefined || defaultBranch === undefined) return true;
  return ref === `refs/heads/${defaultBranch}`;
}
