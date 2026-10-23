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

export function identities(env: Readonly<Record<string, string | undefined>>): Identities {
  const org = env.TALOS_ORG ?? 'SVP-Labs';
  return {
    owner: env.TALOS_OWNER ?? 'SvenPGH',
    thea: bot(env.TALOS_THEA_APP ?? 'thea-svp'),
    reviewer: bot(env.TALOS_REVIEWER_APP ?? 'talos-reviewer'),
    release: bot(env.TALOS_RELEASE_APP ?? 'talos-release'),
    org,
    talosRepo: `${org}/Talos`,
  };
}

export const DEPENDABOT = 'dependabot[bot]';
