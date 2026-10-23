import { z } from 'zod';
import type { Os, Tier } from './check.js';
import type { Reported } from './finding.js';

type Status = 'passed' | 'findings' | 'skipped' | 'error';

export type Outcome = {
  readonly check: string;
  readonly tier: Tier;
  /** The component's root, for component-scoped checks. */
  readonly component?: string;
  readonly status: Status;
  /** Why it was skipped, or what went wrong. */
  readonly reason?: string;
  readonly durationMs: number;
  readonly findings: readonly Reported[];
};

/** One `talos run`: the checks of some tiers at one commit on one OS. */
export type RunResult = {
  readonly talos: string;
  readonly sha: string;
  readonly tiers: readonly Tier[];
  readonly os: Os;
  readonly outcomes: readonly Outcome[];
};

const location = z.object({
  file: z.string(),
  line: z.number(),
  endLine: z.number().optional(),
  column: z.number().optional(),
});

const reported = z.object({
  rule: z.string(),
  message: z.string(),
  location: location.optional(),
  key: z.string().optional(),
  docs: z.string().optional(),
  check: z.string(),
  fingerprint: z.string(),
  policy: z.enum(['standard', 'always', 'lost', 'info']),
});

const outcome = z.object({
  check: z.string(),
  tier: z.enum(['commit', 'head']),
  component: z.string().optional(),
  status: z.enum(['passed', 'findings', 'skipped', 'error']),
  reason: z.string().optional(),
  durationMs: z.number(),
  findings: z.array(reported),
});

const runResultSchema = z.object({
  talos: z.string(),
  sha: z.string(),
  tiers: z.array(z.enum(['commit', 'head'])),
  os: z.enum(['linux', 'windows', 'macos']),
  outcomes: z.array(outcome),
});

export function parseRunResult(text: string): RunResult {
  return runResultSchema.parse(JSON.parse(text)) as RunResult;
}

export function findingsOf(result: RunResult, tier?: Tier): Reported[] {
  return result.outcomes
    .filter((o) => tier === undefined || o.tier === tier)
    .flatMap((o) => o.findings);
}

export function engineErrors(result: RunResult): Outcome[] {
  return result.outcomes.filter((o) => o.status === 'error');
}
