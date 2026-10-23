/**
 * Who is who. The caller workflow passes these from organisation variables, so the
 * kit names no account; the defaults are SVP-Labs's own.
 */
export type Identities = {
  /** The owner: the one person whose approval `talos/review` accepts. */
  readonly owner: string;
  /** Thea's App, which implements, and whose `talos-approve` reviews carry the owner's okay. */
  readonly thea: string;
  /** The reviewer App: reviews, publishes `talos/review`, files debt and security issues. */
  readonly reviewer: string;
  /** The release App, which moves pins and reads settings for the drift report. */
  readonly release: string;
  /** The organisation every governed repository lives in. */
  readonly org: string;
  /** The kit's own repository. */
  readonly talosRepo: string;
};

function bot(slug: string): string {
  return `${slug}[bot]`;
}

/** An unset organisation variable reaches a workflow as an empty string. */
function setting(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

export function identities(env: Readonly<Record<string, string | undefined>>): Identities {
  const org = setting(env.TALOS_ORG, 'SVP-Labs');
  return {
    owner: setting(env.TALOS_OWNER, 'SvenPGH'),
    thea: bot(setting(env.TALOS_THEA_APP, 'thea-svp')),
    reviewer: bot(setting(env.TALOS_REVIEWER_APP, 'talos-reviewer')),
    release: bot(setting(env.TALOS_RELEASE_APP, 'talos-release')),
    org,
    talosRepo: `${org}/Talos`,
  };
}

export const DEPENDABOT = 'dependabot[bot]';

/**
 * Whether two logins name the same account. GitHub matches logins without case, in CODEOWNERS
 * too, so a configured identity written in another case than the API returns is still that one.
 */
export function sameLogin(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.toLowerCase() === b.toLowerCase();
}
