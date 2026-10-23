import type { GitHub } from '../github/api.js';
import type { Identities } from '../github/identities.js';
import { listInstallationRepositories, propertyOf, type Repository } from '../github/repos.js';
import { parseIssues, type Issue } from '../ticket/schemas.js';

/**
 * Each central matrix job mints a token limited to the one repository its index names, so the
 * repository is learnt from the token itself and its name never passes through the workflow.
 */
export class CentralError extends Error {
  override readonly name = 'CentralError';
}

const CHANNEL_VALUES: ReadonlySet<string> = new Set(['evaluate', 'canary', 'stable']);

/** The one repository a scoped installation token reaches. */
export async function soleRepository(gh: GitHub): Promise<Repository> {
  const repos = await listInstallationRepositories(gh);
  const [only] = repos;
  if (repos.length !== 1 || only === undefined) {
    throw new CentralError(`the token reaches ${repos.length} repositories, not one`);
  }
  return only;
}

/** A repository Talos governs: not archived, its `talos` property naming a channel. */
export function isGoverned(repo: Repository): boolean {
  return !repo.archived && CHANNEL_VALUES.has(propertyOf(repo, 'talos') ?? '');
}

/** Open issues with `label` that Talos's reviewer App filed. */
export async function openTalosIssues(
  gh: GitHub,
  at: { readonly repo: string; readonly who: Identities },
  label: string,
): Promise<Issue[]> {
  const raw = await gh.paginate<unknown>(
    `repos/${at.repo}/issues?state=open&labels=${encodeURIComponent(label)}`,
  );
  return parseIssues(raw).filter((issue) => !issue.isPull && issue.author === at.who.reviewer);
}

/** Closes an issue Talos filed, as done: what it reported is gone. */
export async function closeIssue(gh: GitHub, repo: string, number: number): Promise<void> {
  await gh.request('PATCH', `repos/${repo}/issues/${number}`, {
    body: { state: 'closed', state_reason: 'completed' },
  });
}
