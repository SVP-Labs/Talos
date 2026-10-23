import { z } from 'zod';
import { type InstallationState, readInstallations } from './installations.js';
import { type LiveRuleset, readRulesets } from './rulesets-api.js';
import { type GitHub, GitHubError } from '../github/api.js';
import { readFileAt } from '../github/contents.js';
import type { Identities } from '../github/identities.js';
import { propertyValuesSchema } from '../github/repos.js';

/** Where the caller lives in every governed repository. */
export const CALLER_PATH = '.github/workflows/talos.yml';

/** Where GitHub looks for CODEOWNERS, in its order. */
export const CODEOWNERS_PATHS: readonly string[] = [
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'docs/CODEOWNERS',
];

export const MERGE_QUEUE_RULESET = 'talos-merge-queue';
export const OWNER_REVIEW_RULESET = 'talos-owner-review';

const repositorySchema = z.object({
  id: z.number().int(),
  default_branch: z.string().min(1),
  allow_rebase_merge: z.boolean().optional(),
  allow_squash_merge: z.boolean().optional(),
  allow_merge_commit: z.boolean().optional(),
  allow_auto_merge: z.boolean().optional(),
  delete_branch_on_merge: z.boolean().optional(),
  pull_request_creation_policy: z.string().optional(),
});

export type RepoSettings = Omit<z.infer<typeof repositorySchema>, 'id' | 'default_branch'>;

export type RepoState = {
  readonly repo: string;
  readonly id: number;
  readonly defaultBranch: string;
  readonly head: string;
  readonly settings: RepoSettings;
  readonly caller: string | undefined;
  readonly codeowners: { readonly path: string; readonly text: string } | undefined;
  /** Every workflow file on the default branch, for finding the old kit's callers. */
  readonly workflows: readonly { readonly path: string; readonly text: string }[];
  /** Files `talos new` adds with the caller, keyed by path, as they are now. */
  readonly extra: Readonly<Record<string, string | undefined>>;
  readonly rulesets: readonly LiveRuleset[];
  readonly alerts: boolean;
  readonly properties: Readonly<Record<string, string | null>>;
  readonly installations: readonly InstallationState[];
};

const refSchema = z.object({ object: z.object({ sha: z.string() }) });
const listingSchema = z.array(z.object({ path: z.string(), type: z.string() }));

async function workflowFiles(
  gh: GitHub,
  repo: string,
  ref: string,
): Promise<{ path: string; text: string }[]> {
  const raw = await gh.request<unknown>(
    'GET',
    `repos/${repo}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`,
    { allowMissing: true },
  );
  if (raw === undefined) return [];
  const parsed = listingSchema.safeParse(raw);
  if (!parsed.success) return [];
  const files = parsed.data.filter((entry) => entry.type === 'file').slice(0, 100);
  const texts = await Promise.all(files.map((f) => readFileAt(gh, repo, f.path, ref)));
  return files.flatMap((file, index) => {
    const text = texts[index];
    return text === undefined ? [] : [{ path: file.path, text }];
  });
}

async function codeowners(gh: GitHub, repo: string, ref: string): Promise<RepoState['codeowners']> {
  for (const path of CODEOWNERS_PATHS) {
    const text = await readFileAt(gh, repo, path, ref);
    if (text !== undefined) return { path, text };
  }
  return undefined;
}

/** Dependabot alerts: 204 when on, 404 when off. */
async function alertsOn(gh: GitHub, repo: string): Promise<boolean> {
  try {
    await gh.request('GET', `repos/${repo}/vulnerability-alerts`);
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return false;
    throw error;
  }
}

async function propertyValues(gh: GitHub, repo: string): Promise<Record<string, string | null>> {
  const raw = await gh.request<unknown>('GET', `repos/${repo}/properties/values`);
  const values: Record<string, string | null> = {};
  for (const entry of propertyValuesSchema.parse(raw)) {
    values[entry.property_name] = Array.isArray(entry.value) ? entry.value.join(',') : entry.value;
  }
  return values;
}

export type ReadOptions = {
  /** Files `talos new` adds with the caller, read so a rerun knows they are there. */
  readonly extraPaths?: readonly string[];
  /**
   * Whether to read the App installations, which needs an org owner's token; the drift report,
   * reading as `talos-release`, leaves them out.
   */
  readonly installations?: boolean;
};

/**
 * Everything `talos govern` compares with what it would set. The owner's token reads it all; a
 * token with `administration: read` on the repository reads everything but the installations.
 */
export async function readRepoState(
  gh: GitHub,
  repo: string,
  who: Identities,
  options: ReadOptions = {},
): Promise<RepoState> {
  const extraPaths = options.extraPaths ?? [];
  const raw = repositorySchema.parse(await gh.request<unknown>('GET', `repos/${repo}`));
  const { id, default_branch: defaultBranch, ...settings } = raw;
  const ref = await gh.request<unknown>(
    'GET',
    `repos/${repo}/git/ref/heads/${defaultBranch.split('/').map(encodeURIComponent).join('/')}`,
  );
  const head = refSchema.parse(ref).object.sha;
  const [caller, owners, workflows, extras, rulesets, alerts, properties, installations] =
    await Promise.all([
      readFileAt(gh, repo, CALLER_PATH, head),
      codeowners(gh, repo, head),
      workflowFiles(gh, repo, head),
      Promise.all(extraPaths.map((path) => readFileAt(gh, repo, path, head))),
      readRulesets(gh, { kind: 'repo', repo }, [MERGE_QUEUE_RULESET, OWNER_REVIEW_RULESET]),
      alertsOn(gh, repo),
      propertyValues(gh, repo),
      options.installations === false ? [] : readInstallations(gh, who, id),
    ]);
  const extra = Object.fromEntries(extraPaths.map((path, index) => [path, extras[index]]));
  return {
    repo,
    id,
    defaultBranch,
    head,
    settings,
    caller,
    codeowners: owners,
    workflows,
    extra,
    rulesets,
    alerts,
    properties,
    installations,
  };
}
