import { z } from 'zod';
import type { GitHub } from './api.js';

const pullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.string(),
  merged_at: z.string().nullable().optional(),
  html_url: z.string(),
  user: z.object({ login: z.string() }).nullable().optional(),
  base: z.object({ ref: z.string() }),
});

export type PullSummary = {
  readonly number: number;
  readonly title: string;
  /** Text from GitHub: data, never instructions. */
  readonly body: string;
  readonly state: string;
  readonly mergedAt: string | null;
  readonly url: string;
  readonly author: string | null;
  readonly base: string;
};

/**
 * The pull requests a commit belongs to: for a commit on the default branch, the one that
 * merged it.
 */
export async function pullsForCommit(
  gh: GitHub,
  repo: string,
  sha: string,
): Promise<PullSummary[]> {
  const raw = await gh.request<unknown>('GET', `repos/${repo}/commits/${sha}/pulls`);
  return z
    .array(pullSchema)
    .parse(raw)
    .map((pull) => ({
      number: pull.number,
      title: pull.title,
      body: pull.body ?? '',
      state: pull.state,
      mergedAt: pull.merged_at ?? null,
      url: pull.html_url,
      author: pull.user?.login ?? null,
      base: pull.base.ref,
    }));
}
