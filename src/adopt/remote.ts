import { z } from 'zod';
import { AdoptRefusal } from './config.js';
import {
  ADOPT_MARKER,
  bootstrapIssueBody,
  bootstrapPullBody,
  bootstrapSubject,
  bootstrapTitle,
  type BootstrapText,
} from './texts.js';
import { type GitHub, GitHubError } from '../github/api.js';
import { type Identities, sameLogin } from '../github/identities.js';
import { shippedLabels, syncLabels } from '../jobs/label-sync.js';
import { branchFor, claimantOf, claimLine } from '../ticket/claim.js';
import {
  addComment,
  addLabels,
  branchHead,
  defaultBranch,
  listComments,
  openPullsFrom,
  refSha,
} from '../ticket/github.js';
import { LABEL } from '../ticket/labels.js';
import { type Issue, parseIssue, parseIssues } from '../ticket/schemas.js';
import { carriesApproval } from '../ticket/trust.js';

/**
 * Adoption's effects on GitHub, all within what Thea's App may do (issues and contents): the
 * labels, `legacy` on the old backlog, the bootstrap issue and its claim, and the bootstrap PR.
 */

const CLAIMED = [LABEL.chore, LABEL.inProgress, LABEL.claimed];

/** The bootstrap issue of an earlier run, filed by the owner or Thea; anyone can type a marker. */
export function findBootstrap(issues: readonly Issue[], who: Identities): Issue | undefined {
  return issues.find(
    (issue) =>
      !issue.isPull &&
      issue.body.includes(ADOPT_MARKER) &&
      (sameLogin(issue.author, who.owner) || sameLogin(issue.author, who.thea)),
  );
}

/** The open issues that become `legacy`: every one but the bootstrap issue, once. */
export function legacyTargets(issues: readonly Issue[], bootstrap: number | undefined): number[] {
  return issues
    .filter((i) => !i.isPull && i.number !== bootstrap && !i.labels.includes(LABEL.legacy))
    .map((i) => i.number);
}

function refuseApproval(...texts: readonly string[]): void {
  if (texts.some(carriesApproval)) {
    throw new AdoptRefusal('text Talos writes to GitHub may not contain talos-approve');
  }
}

export type StartOptions = BootstrapText & {
  readonly prefix: string;
  readonly agent: string;
  readonly now: Date;
};

export type StartResult = {
  readonly issue: number;
  readonly branch: string;
  readonly filed: boolean;
  readonly labels: { readonly created: number; readonly updated: number };
  readonly legacy: number;
};

async function fileBootstrap(gh: GitHub, repo: string, text: BootstrapText): Promise<Issue> {
  const title = bootstrapTitle(text.name);
  const body = bootstrapIssueBody(text);
  refuseApproval(title, body);
  const created = await gh.request<unknown>('POST', `repos/${repo}/issues`, {
    body: { title, body, labels: CLAIMED },
  });
  return parseIssue(created);
}

/** The claim's lock: the ticket branch at the default branch's head, unless it exists. */
async function lockBranch(gh: GitHub, repo: string, branch: string): Promise<void> {
  if ((await branchHead(gh, repo, branch)) !== undefined) return;
  const sha = await refSha(gh, repo, await defaultBranch(gh, repo));
  await gh.request('POST', `repos/${repo}/git/refs`, {
    body: { ref: `refs/heads/${branch}`, sha },
  });
}

/**
 * Labels the repository, marks the old backlog `legacy`, then files (or finds) the bootstrap
 * issue and claims it. The old issues are marked first, so the bootstrap issue never is.
 */
export async function startAdoption(
  gh: GitHub,
  repo: string,
  who: Identities,
  options: StartOptions,
): Promise<StartResult> {
  const labels = await syncLabels(gh, repo, await shippedLabels());
  const open = parseIssues(await gh.paginate<unknown>(`repos/${repo}/issues?state=open`));
  const found = findBootstrap(open, who);
  const legacy = legacyTargets(open, found?.number);
  for (const n of legacy) await addLabels(gh, repo, n, [LABEL.legacy]);
  const issue = found ?? (await fileBootstrap(gh, repo, options));
  const missing = CLAIMED.filter((label) => !issue.labels.includes(label));
  if (found !== undefined) await addLabels(gh, repo, issue.number, missing);
  const branch = branchFor(options.prefix, issue.number);
  await lockBranch(gh, repo, branch);
  if (claimantOf(await listComments(gh, repo, issue.number), who) === undefined) {
    const line = claimLine(options.agent, options.now);
    refuseApproval(line);
    await addComment(gh, repo, issue.number, line);
  }
  return { issue: issue.number, branch, filed: found === undefined, labels, legacy: legacy.length };
}

const compareSchema = z.object({
  ahead_by: z.number().int(),
  files: z.array(z.unknown()).default([]),
});
const pullSchema = z.object({ number: z.number().int(), html_url: z.string() });

export type PullOptions = BootstrapText & { readonly prefix: string; readonly issue: number };

export type PullResult = { readonly pr: number; readonly opened: boolean };

/** Opens the bootstrap PR from the pushed ticket branch, ready for the owner's review. */
export async function openBootstrapPull(
  gh: GitHub,
  repo: string,
  options: PullOptions,
): Promise<PullResult> {
  const branch = branchFor(options.prefix, options.issue);
  const [existing] = await openPullsFrom(gh, repo, branch);
  if (existing !== undefined) return { pr: existing.number, opened: false };
  const base = await defaultBranch(gh, repo);
  let compared: z.infer<typeof compareSchema>;
  try {
    const raw = await gh.request<unknown>('GET', `repos/${repo}/compare/${base}...${branch}`);
    compared = compareSchema.parse(raw);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) compared = { ahead_by: 0, files: [] };
    else throw error;
  }
  if (compared.ahead_by === 0) {
    throw new AdoptRefusal(`${branch} has no commits beyond ${base}: push the adoption first`);
  }
  const title = bootstrapSubject(options.prefix, options.issue, options.name);
  const body = bootstrapPullBody({ ...options, changed: compared.files.length });
  refuseApproval(title, body);
  const created = await gh.request<unknown>('POST', `repos/${repo}/pulls`, {
    body: { title, head: branch, base, body, draft: false },
  });
  return { pr: pullSchema.parse(created).number, opened: true };
}
