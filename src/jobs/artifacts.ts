import { z } from 'zod';
import { type GitHub, GitHubError } from '../github/api.js';

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

export type Download = (url: string) => Promise<Uint8Array>;

/**
 * Downloads an artifact's zip with the workflow's token. GitHub answers with a redirect to a
 * short-lived storage URL, which is followed by hand so the token never travels there.
 */
export function downloader(token: string, fetchImpl: typeof fetch = fetch): Download {
  return async (url) => {
    if (!url.startsWith('https://')) throw new GitHubError('GET artifact: not https', 0);
    const first = await fetchImpl(url, {
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'svp-labs-talos',
      },
    });
    const location = first.headers.get('location');
    const response =
      first.status >= 300 && first.status < 400 && location !== null
        ? await fetchImpl(location)
        : first;
    if (!response.ok) throw new GitHubError(`GET artifact: ${response.status}`, response.status);
    return new Uint8Array(await response.arrayBuffer());
  };
}
