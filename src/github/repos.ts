import { z } from 'zod';
import type { GitHub } from './api.js';

const propertyValue = z.union([z.string(), z.array(z.string()), z.null()]);

/** `GET repos/{repo}/properties/values`: each custom property's value on a repository. */
export const propertyValuesSchema = z.array(
  z.object({ property_name: z.string(), value: propertyValue }),
);

const repositorySchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  default_branch: z.string().optional(),
  archived: z.boolean().default(false),
  private: z.boolean().default(false),
  custom_properties: z.record(z.string(), propertyValue).optional(),
});

export type Repository = {
  readonly id: number;
  /** `owner/name`. */
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly archived: boolean;
  readonly private: boolean;
  /** The organisation's custom properties set on the repository (`talos`, `talos-agents`). */
  readonly properties: Readonly<Record<string, string | readonly string[] | null>>;
};

function toRepository(raw: z.infer<typeof repositorySchema>): Repository {
  return {
    id: raw.id,
    fullName: raw.full_name,
    defaultBranch: raw.default_branch ?? 'main',
    archived: raw.archived,
    private: raw.private,
    properties: raw.custom_properties ?? {},
  };
}

export async function getRepository(gh: GitHub, repo: string): Promise<Repository> {
  return toRepository(repositorySchema.parse(await gh.request<unknown>('GET', `repos/${repo}`)));
}

/** Every repository of `org` the token can see, archived ones included. */
export async function listOrgRepositories(gh: GitHub, org: string): Promise<Repository[]> {
  const raw = await gh.paginate<unknown>(`orgs/${encodeURIComponent(org)}/repos?type=all`);
  return z.array(repositorySchema).parse(raw).map(toRepository);
}

/** The repositories an App installation token reaches (`GET /installation/repositories`). */
export async function listInstallationRepositories(gh: GitHub): Promise<Repository[]> {
  const raw = await gh.paginate<unknown>('installation/repositories', 'repositories');
  return z.array(repositorySchema).parse(raw).map(toRepository);
}

/** A single-valued custom property, or `undefined` when it is unset or multi-valued. */
export function propertyOf(repository: Repository, name: string): string | undefined {
  const value = repository.properties[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
