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

const propertyRowSchema = z.object({
  repository_id: z.number().int(),
  repository_full_name: z.string(),
  properties: propertyValuesSchema,
});

/** A repository as the organisation's custom property listing names it. */
export type PropertyRow = {
  readonly id: number;
  /** `owner/name`. */
  readonly fullName: string;
  readonly properties: Readonly<Record<string, string | readonly string[] | null>>;
};

/**
 * The organisation's repositories with their custom property values
 * (`GET /orgs/{org}/properties/values`), narrowed by `query`, a repository search such as
 * `is:private`. An organisation permission (Custom properties, read) is enough, so a token that
 * reaches no repository can list them.
 */
export async function listPropertyValues(
  gh: GitHub,
  org: string,
  query?: string,
): Promise<PropertyRow[]> {
  const search = query === undefined ? '' : `?repository_query=${encodeURIComponent(query)}`;
  const raw = await gh.paginate<unknown>(
    `orgs/${encodeURIComponent(org)}/properties/values${search}`,
  );
  return z
    .array(propertyRowSchema)
    .parse(raw)
    .map((row) => ({
      id: row.repository_id,
      fullName: row.repository_full_name,
      properties: Object.fromEntries(row.properties.map((p) => [p.property_name, p.value])),
    }));
}

/** A single-valued custom property, or `undefined` when it is unset or multi-valued. */
export function propertyOf(repository: Repository, name: string): string | undefined {
  const value = repository.properties[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
