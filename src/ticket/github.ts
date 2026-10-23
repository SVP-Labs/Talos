import {
  branchSchema,
  type Comment,
  contentsFileSchema,
  type Issue,
  parseComments,
  parseIssue,
  parsePulls,
  type Pull,
  refSchema,
  repoSchema,
} from './schemas.js';
import { parseConfig } from '../config/load.js';
import type { TalosConfig } from '../config/schema.js';
import { type GitHub, GitHubError } from '../github/api.js';

/** Thin calls over the REST API, each validating what it returns. */

export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export async function defaultBranch(gh: GitHub, repo: string): Promise<string> {
  return repoSchema.parse(await gh.request<unknown>('GET', `repos/${repo}`)).default_branch;
}

/** An issue, or `undefined` when it doesn't exist. Pull requests come back as issues too. */
export async function getIssue(gh: GitHub, repo: string, n: number): Promise<Issue | undefined> {
  const data = await gh.request<unknown>('GET', `repos/${repo}/issues/${n}`, {
    allowMissing: true,
  });
  return data === undefined ? undefined : parseIssue(data);
}

export async function listComments(gh: GitHub, repo: string, n: number): Promise<Comment[]> {
  return parseComments(await gh.paginate<unknown>(`repos/${repo}/issues/${n}/comments`));
}

export async function addComment(gh: GitHub, repo: string, n: number, body: string): Promise<void> {
  await gh.request('POST', `repos/${repo}/issues/${n}/comments`, { body: { body } });
}

export async function addLabels(
  gh: GitHub,
  repo: string,
  n: number,
  labels: readonly string[],
): Promise<void> {
  if (labels.length === 0) return;
  await gh.request('POST', `repos/${repo}/issues/${n}/labels`, { body: { labels } });
}

/** Removing a label the issue doesn't carry is not an error. */
async function removeLabel(gh: GitHub, repo: string, n: number, label: string): Promise<void> {
  await gh.request('DELETE', `repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`, {
    allowMissing: true,
  });
}

export async function changeLabels(
  gh: GitHub,
  repo: string,
  n: number,
  change: { readonly add: readonly string[]; readonly remove: readonly string[] },
): Promise<void> {
  for (const label of change.remove) await removeLabel(gh, repo, n, label);
  await addLabels(gh, repo, n, change.add);
}

/** The commit a branch points at, or `undefined` when there is no such branch. */
export async function branchHead(
  gh: GitHub,
  repo: string,
  branch: string,
): Promise<{ sha: string; date: string | undefined } | undefined> {
  const data = await gh.request<unknown>('GET', `repos/${repo}/branches/${encodePath(branch)}`, {
    allowMissing: true,
  });
  if (data === undefined) return undefined;
  const commit = branchSchema.parse(data).commit;
  return { sha: commit.sha, date: commit.commit.committer?.date };
}

export async function refSha(gh: GitHub, repo: string, branch: string): Promise<string> {
  const data = await gh.request<unknown>(
    'GET',
    `repos/${repo}/git/ref/heads/${encodePath(branch)}`,
  );
  return refSchema.parse(data).object.sha;
}

/**
 * Deletes a branch. A branch that is already gone answers 422 or 404, which is the outcome
 * wanted; any other refusal (403 for a token without `contents: write`) throws.
 */
export async function deleteBranch(gh: GitHub, repo: string, branch: string): Promise<boolean> {
  try {
    await gh.request('DELETE', `repos/${repo}/git/refs/heads/${encodePath(branch)}`, {
      allowMissing: true,
    });
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 422) return false;
    throw error;
  }
}

/** The open pull requests whose head is `branch` in the repository itself. */
export async function openPullsFrom(gh: GitHub, repo: string, branch: string): Promise<Pull[]> {
  const owner = repo.split('/')[0] ?? '';
  const head = encodeURIComponent(`${owner}:${branch}`);
  const data = await gh.request<unknown>('GET', `repos/${repo}/pulls?state=open&head=${head}`);
  return parsePulls(data).filter((p) => p.headRef === branch);
}

/** A file's text at a ref, or `undefined` when it doesn't exist there. */
export async function fileAt(
  gh: GitHub,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  const data = await gh.request<unknown>(
    'GET',
    `repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    { allowMissing: true },
  );
  if (data === undefined) return undefined;
  const file = contentsFileSchema.safeParse(data);
  return file.success ? Buffer.from(file.data.content, 'base64').toString('utf8') : undefined;
}

/** `talos.yml` as it is at a ref, read through the API. */
export async function configAt(gh: GitHub, repo: string, ref: string): Promise<TalosConfig> {
  const text = await fileAt(gh, repo, 'talos.yml', ref);
  if (text === undefined) {
    throw new Error(`talos.yml not found at ${ref}: the repository is not governed`);
  }
  return parseConfig(text);
}
