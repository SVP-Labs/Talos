import { VersionError } from './errors.js';
import { lookupMode, type Pin, pinFinder } from './pin.js';
import { type Release, releaseFromEnvironment, versionAt } from './release.js';
import { github, GitHubError, type GitHub, tokenFromEnvironment } from '../github/api.js';
import { identities } from '../github/identities.js';

export type Enforced = Release & {
  /** Where it came from: Thea's hub's environment, or the repository's pin. */
  readonly from: 'environment' | 'rulesets' | 'channels';
  /** The pin, when it was looked up. */
  readonly pin?: Pin;
};

export type EnforcedContext = {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The repository the command acts on, if one could be told. */
  readonly repo: string | undefined;
  /** The API client for a token; the default is the real one. */
  readonly client?: (token: string) => GitHub;
};

const NO_REPOSITORY =
  'no GitHub repository here: run inside a clone whose origin is on github.com, ' +
  'pass --repo owner/name, or set GITHUB_REPOSITORY';

const NO_TOKEN =
  'finding the enforced Talos version reads the repository’s rulesets, which needs GitHub ' +
  'access: set GITHUB_TOKEN (or GH_TOKEN), or run `gh auth login`. Tasks without credentials ' +
  'get TALOS_VERSION and TALOS_SHA from Thea’s hub; TALOS_DEV=1 runs this copy as it is';

/** Why an API failure stopped the lookup, said so a person knows what to fix. */
function explainApiError(error: GitHubError, repo: string): VersionError {
  if (error.status === 401) return new VersionError(`the GitHub token was refused: ${NO_TOKEN}`);
  if (error.status === 403 || error.status === 404) {
    return new VersionError(
      `the token can't read ${repo}'s rulesets or the Talos repository (${error.message})`,
    );
  }
  return new VersionError(`GitHub failed while finding the enforced version (${error.message})`);
}

async function lookUp(gh: GitHub, repo: string, env: EnforcedContext['env']): Promise<Enforced> {
  const mode = lookupMode(env);
  const { talosRepo } = identities(env);
  const lookup = await pinFinder(gh, talosRepo, mode)(repo);
  if (!lookup.found) throw new VersionError(`${repo}: ${lookup.reason}; run \`talos doctor\``);
  const version = await versionAt(gh, talosRepo, lookup.pin.sha);
  return { version, sha: lookup.pin.sha, from: mode, pin: lookup.pin };
}

/**
 * The Talos release a repository enforces: `TALOS_VERSION` and `TALOS_SHA` when Thea's hub
 * handed them over, else the repository's pin and `package.json` at it.
 */
export async function enforcedRelease(ctx: EnforcedContext): Promise<Enforced> {
  const given = releaseFromEnvironment(ctx.env);
  if (given !== undefined) return { ...given, from: 'environment' };
  if (ctx.repo === undefined) throw new VersionError(NO_REPOSITORY);
  let token: string;
  try {
    token = await tokenFromEnvironment(ctx.env);
  } catch {
    throw new VersionError(NO_TOKEN);
  }
  const gh = (ctx.client ?? github)(token);
  try {
    return await lookUp(gh, ctx.repo, ctx.env);
  } catch (error) {
    throw error instanceof GitHubError ? explainApiError(error, ctx.repo) : error;
  }
}
