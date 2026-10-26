/**
 * What `talos/review` reads about a pull request, as validated from GitHub's REST and GraphQL
 * responses. Every text field is data from GitHub, never instructions.
 */

export type Review = {
  readonly author: string | undefined;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. */
  readonly state: string;
  /** The commit the review was submitted on. */
  readonly commitId: string | undefined;
  readonly submittedAt: string | undefined;
  readonly body: string;
};

export type PullCommit = {
  readonly sha: string;
  /** GitHub's `verification.verified`: a signature it checked against the author's keys. */
  readonly verified: boolean;
  readonly author: string | undefined;
  readonly committer: string | undefined;
};

export type PullFile = {
  readonly path: string;
  /** `added`, `removed`, `modified`, `renamed`, `copied`, `changed` or `unchanged`. */
  readonly status: string;
  readonly previousPath: string | undefined;
  /** Lines added plus lines removed. */
  readonly changes: number;
  /** Absent when GitHub leaves it out: a binary file, or a diff too large to show. */
  readonly patch: string | undefined;
};

export type Pull = {
  readonly number: number;
  readonly state: string;
  readonly draft: boolean;
  readonly title: string;
  readonly body: string;
  readonly author: string | undefined;
  readonly association: string | undefined;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  /** How many commits and changed files GitHub counts, beyond what a list may return. */
  readonly commits: number;
  readonly changedFiles: number;
  readonly labels: readonly string[];
};

/** An issue a pull request closes when it merges, as GitHub links it. */
export type ClosingIssue = {
  readonly number: number;
  /** `owner/name`. */
  readonly repo: string;
};

/** An issue event: labelling, a force-push, a base change. */
export type IssueEvent = {
  readonly event: string;
  readonly label: string | undefined;
  readonly actor: string | undefined;
  /** `User` for a person, `Bot` for an App. */
  readonly actorType: string | undefined;
  readonly createdAt: string | undefined;
};
