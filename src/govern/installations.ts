import { z } from 'zod';
import { change, manual, ok, type Step } from './steps.js';
import { type GitHub, GitHubError } from '../github/api.js';
import type { Identities } from '../github/identities.js';

/**
 * The Apps every governed repository is added to: Thea's, which implements; `talos-reviewer`,
 * which reviews and files issues; and `talos-release`, whose drift report mints a token per
 * repository. Their installations are found through `GET /orgs/{org}/installations`, which an
 * org owner's token may call. An installation set to all repositories needs nothing. For one set
 * to selected repositories, `GET /user/installations/{installation_id}/repositories` says
 * whether the repository is in it, and only with the `read:user` scope; and
 * `PUT /user/installations/{installation_id}/repositories/{repository_id}` adds it, which GitHub
 * refuses (403) to `gh`'s OAuth token, even an org owner's. Where either is refused, the step is
 * the owner's, by hand, in the org's settings.
 */
export type AppRole = 'thea' | 'reviewer' | 'release';

const ROLES: readonly AppRole[] = ['thea', 'reviewer', 'release'];

export function appSlug(who: Identities, role: AppRole): string {
  return who[role].replace(/\[bot\]$/, '');
}

const installationSchema = z.object({
  id: z.number().int(),
  app_slug: z.string(),
  repository_selection: z.enum(['all', 'selected']),
});

type Installation = z.infer<typeof installationSchema>;

export type InstallationState = {
  readonly role: AppRole;
  readonly slug: string;
  readonly installation: Installation | undefined;
  /** Whether the repository is in the installation; `undefined` when the token can't tell. */
  readonly member: boolean | undefined;
};

async function orgInstallations(gh: GitHub, org: string): Promise<Installation[]> {
  const raw = await gh.paginate<unknown>(
    `orgs/${encodeURIComponent(org)}/installations`,
    'installations',
  );
  return z.array(installationSchema).parse(raw);
}

async function isMember(
  gh: GitHub,
  installation: Installation,
  repositoryId: number,
): Promise<boolean | undefined> {
  if (installation.repository_selection === 'all') return true;
  try {
    const raw = await gh.paginate<unknown>(
      `user/installations/${installation.id}/repositories`,
      'repositories',
    );
    return z
      .array(z.object({ id: z.number().int() }))
      .parse(raw)
      .some((repository) => repository.id === repositoryId);
  } catch (error) {
    if (error instanceof GitHubError) return undefined;
    throw error;
  }
}

export async function readInstallations(
  gh: GitHub,
  who: Identities,
  repositoryId: number,
): Promise<InstallationState[]> {
  const installations = await orgInstallations(gh, who.org);
  return Promise.all(
    ROLES.map(async (role) => {
      const slug = appSlug(who, role);
      const installation = installations.find((i) => i.app_slug === slug);
      const member =
        installation === undefined ? false : await isMember(gh, installation, repositoryId);
      return { role, slug, installation, member };
    }),
  );
}

/** Where an org owner adds a repository to an App's installation by hand. */
function byHand(slug: string, repo: string): string {
  return (
    `add ${repo} to ${slug}'s installation if it isn't there: Org Settings → GitHub Apps → ` +
    `${slug} → Configure → Repository access → add the repository → Save`
  );
}

/**
 * One step per App: already there, added, or by hand: installing the App on the org, or adding
 * the repository where the token may not read the installation or GitHub refuses the change.
 */
export function installationSteps(
  states: readonly InstallationState[],
  repository: { readonly id: number; readonly name: string },
): Step[] {
  return states.map((state) => {
    const id = `app:${state.slug}`;
    if (state.installation === undefined) {
      return manual(id, `install the ${state.slug} App on the organisation, then rerun`);
    }
    if (state.member === true) return ok(id, `${state.slug} reaches the repository`);
    if (state.member === undefined) return manual(id, byHand(state.slug, repository.name));
    return change(
      id,
      `add the repository to ${state.slug}'s installation`,
      { kind: 'install', installationId: state.installation.id, repositoryId: repository.id },
      byHand(state.slug, repository.name),
    );
  });
}
