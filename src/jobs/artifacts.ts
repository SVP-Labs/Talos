import { z } from 'zod';
import type { GitHub } from '../github/api.js';

const artifactList = z.object({
  artifacts: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      size_in_bytes: z.number().int().nonnegative(),
      expired: z.boolean(),
      created_at: z.string().nullable().optional(),
      archive_download_url: z.string(),
    }),
  ),
});

export type Artifact = {
  readonly id: number;
  readonly createdAt: string;
  readonly url: string;
};

/** Artifacts above this size are skipped: a verdict is a few kilobytes. */
const MAX_ARTIFACT = 5 * 1024 * 1024;

/**
 * The newest unexpired artifacts called `name` created since `since`, newest first, at most
 * `max` of them. One page is enough: the list is newest first, and older ones are not wanted.
 */
export async function recentArtifacts(
  actions: GitHub,
  repo: string,
  query: { readonly name: string; readonly since: Date; readonly max: number },
): Promise<Artifact[]> {
  const data = await actions.request<unknown>(
    'GET',
    `repos/${repo}/actions/artifacts?name=${encodeURIComponent(query.name)}&per_page=100`,
  );
  return artifactList
    .parse(data)
    .artifacts.flatMap((a) => {
      const created = a.created_at ?? undefined;
      if (a.expired || a.name !== query.name || a.size_in_bytes > MAX_ARTIFACT) return [];
      if (created === undefined || Date.parse(created) < query.since.getTime()) return [];
      return [{ id: a.id, createdAt: created, url: a.archive_download_url }];
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, query.max);
}
