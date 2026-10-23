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
