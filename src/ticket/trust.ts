import type { Identities } from '../github/identities.js';

/**
 * The `author_association` values of people who may steer an agent. Strangers can comment on a
 * public repository's issues and PRs; their words are data, and nothing they write starts a job.
 */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export type Author = {
  readonly login: string | undefined;
  readonly association: string | undefined;
};

/**
 * Whether an author is the owner, a member or a collaborator, or one of the Apps Talos itself
 * names. An App's `author_association` is not `COLLABORATOR`, so Thea's App and Talos's own are
 * recognised by login, which no person can take: logins ending in `[bot]` belong to Apps.
 */
export function isTrusted(author: Author, who: Identities): boolean {
  if (author.association !== undefined && TRUSTED_ASSOCIATIONS.has(author.association)) {
    return true;
  }
  const login = author.login;
  if (login === undefined) return false;
  return [who.owner, who.thea, who.reviewer, who.release].includes(login);
}

/** Whether Talos's own Apps wrote it: issues and comments Talos files itself. */
export function isTalos(login: string | undefined, who: Identities): boolean {
  return login === who.reviewer || login === who.release;
}

/**
 * Text Thea's tools write must never carry the approval marker: `talos/review` reads a
 * `talos-approve` review from her App as the owner's okay, and only her card may write one.
 */
export function carriesApproval(text: string): boolean {
  return /talos-approve/i.test(text);
}
