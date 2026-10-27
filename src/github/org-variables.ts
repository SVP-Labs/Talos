import { z } from 'zod';
import { type GitHub, GitHubError } from './api.js';
import { identities, type Identities } from './identities.js';

type Env = Readonly<Record<string, string | undefined>>;

/** The organisation variables the caller workflow passes as identities, which a local run reads. */
const VARIABLES = ['TALOS_OWNER', 'TALOS_THEA_APP', 'TALOS_REVIEWER_APP', 'TALOS_RELEASE_APP'];

const variableSchema = z.object({ name: z.string(), value: z.string() });

/**
 * One organisation Actions variable, as the owner's token reads it; `undefined` when the
 * organisation has none of that name, and a refusal tells `warn` which default stands in.
 */
async function orgVariable(
  gh: GitHub,
  org: string,
  name: string,
  warn: (line: string) => void,
): Promise<string | undefined> {
  try {
    const path = `orgs/${encodeURIComponent(org)}/actions/variables/${name}`;
    return variableSchema.parse(await gh.request<unknown>('GET', path)).value;
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    if (error.status !== 404) {
      warn(
        `could not read ${org}'s variable ${name} (${String(error.status)}), so its default ` +
          `stands in: set ${name} to choose, or run \`gh auth refresh -s admin:org\``,
      );
    }
    return undefined;
  }
}

/**
 * The identities an owner's command runs as. In a workflow they come from the organisation's
 * variables through the environment; locally, each one the environment leaves unset is read from
 * those variables, so the owner's terminal names the same Apps as the jobs. The environment wins.
 */
export async function ownerIdentities(
  gh: GitHub,
  env: Env,
  warn: (line: string) => void,
): Promise<Identities> {
  const { org } = identities(env);
  const read = await Promise.all(
    VARIABLES.map(async (name) => {
      const own = env[name];
      if (own !== undefined && own !== '') return [name, own] as const;
      return [name, await orgVariable(gh, org, name, warn)] as const;
    }),
  );
  return identities({ ...env, ...Object.fromEntries(read) });
}
