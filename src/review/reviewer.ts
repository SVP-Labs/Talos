import type { ReviewerState } from './conditions.js';
import { type ReviewComment, submitReview } from './github.js';
import { defused, type Finding, parseHeader, reviewBody, type Verdict } from './header.js';
import { fileChange } from './integrity.js';
import type { ModelResult, ReviewModel } from './model.js';
import { buildPrompt, LIMITS, oversize, type PromptInput, readable } from './prompt.js';
import type { Pull, PullFile, Review } from './types.js';
import { type GitHub, GitHubError } from '../github/api.js';
import { readFileAt } from '../github/contents.js';
import { DEPENDABOT, type Identities, sameLogin } from '../github/identities.js';
import { addLabels } from '../ticket/github.js';
import { clip } from '../ticket/payload.js';
import type { Issue } from '../ticket/schemas.js';
import { isTrusted } from '../ticket/trust.js';

/**
 * The reviewer's AI review, where agents are on: once per head commit, at most two rounds of
 * REQUEST_CHANGES on a PR; a third would-be request labels the work `needs-human` instead.
 */

const NEEDS_HUMAN = 'needs-human';

/** How many rounds of changes the reviewer may request before a person takes over. */
const MAX_ROUNDS = 2;

const COMMENT_MAX = 4000;
const FETCHED_FILES = 30;

export type ReviewerRun =
  | { readonly kind: 'reviewed'; readonly review: Review }
  /** A third request, not submitted: the would-be review's body, when there was one. */
  | { readonly kind: 'needs-human'; readonly body?: string }
  | { readonly kind: 'no-verdict'; readonly reason: string }
  | { readonly kind: 'skipped'; readonly reason: string };

export type ReviewerFacts = {
  readonly repo: string;
  readonly who: Identities;
  readonly agentsOn: boolean;
  readonly pull: Pull;
  readonly files: readonly PullFile[];
  readonly reviews: readonly Review[];
  /** The one issue the PR closes in this repository, when it closes exactly one. */
  readonly issue: Issue | undefined;
};

export type ReviewerDeps = {
  readonly model: ReviewModel;
  rubric(): Promise<string>;
  engineering(): Promise<string>;
};

function byReviewer(reviews: readonly Review[], reviewer: string): Review[] {
  return reviews.filter((r) => sameLogin(r.author, reviewer) && r.state !== 'PENDING');
}

/** The reviewer's latest review of the head commit. */
export function reviewOfHead(
  reviews: readonly Review[],
  reviewer: string,
  head: string,
): Review | undefined {
  return byReviewer(reviews, reviewer)
    .filter((r) => r.commitId === head)
    .at(-1);
}

/** How many rounds of changes the reviewer has requested on the PR, dismissed ones included. */
export function requestedRounds(reviews: readonly Review[], reviewer: string): number {
  return byReviewer(reviews, reviewer).filter((r) => {
    const verdict = parseHeader(r.body)?.verdict;
    return verdict === undefined ? r.state === 'CHANGES_REQUESTED' : verdict === 'REQUEST_CHANGES';
  }).length;
}

/** Whether the work already waits for a person: its issue or the PR is labelled `needs-human`. */
export function waitsForPerson(facts: Pick<ReviewerFacts, 'pull' | 'issue'>): boolean {
  return (
    facts.pull.labels.includes(NEEDS_HUMAN) || (facts.issue?.labels.includes(NEEDS_HUMAN) ?? false)
  );
}

export type StateInput = {
  readonly agentsOn: boolean;
  readonly reviews: readonly Review[];
  readonly reviewer: string;
  readonly head: string;
  readonly run: ReviewerRun | undefined;
  readonly waitsForPerson: boolean;
};

/** A review's state, its round from its header (or counted, for a review without one). */
function stateOfReview(review: Review, requested: number): ReviewerState {
  const header = parseHeader(review.body);
  if (review.state === 'APPROVED') {
    return { kind: 'approved', round: header?.round ?? requested + 1 };
  }
  if (review.state === 'CHANGES_REQUESTED') {
    return { kind: 'changes', round: header?.round ?? requested, findings: header?.findings ?? 0 };
  }
  if (review.state === 'DISMISSED') {
    return { kind: 'waiting', reason: 'its review of the head was dismissed' };
  }
  return { kind: 'waiting', reason: 'it left no verdict on the head' };
}

/** Where the reviewer stands on the head, from its reviews and this run's outcome. */
export function reviewerState(input: StateInput): ReviewerState {
  if (!input.agentsOn) return { kind: 'off' };
  const review = reviewOfHead(input.reviews, input.reviewer, input.head);
  if (review !== undefined) {
    return stateOfReview(review, requestedRounds(input.reviews, input.reviewer));
  }
  const { run } = input;
  if (run?.kind === 'needs-human' || input.waitsForPerson) return { kind: 'needs-human' };
  if (run?.kind === 'no-verdict') return { kind: 'no-verdict', reason: run.reason };
  if (run?.kind === 'skipped') return { kind: 'waiting', reason: run.reason };
  return { kind: 'waiting', reason: 'it has not reviewed the head yet' };
}

/** Why the reviewer doesn't review now, or `undefined` when it should. */
export function notToReview(facts: ReviewerFacts): ReviewerRun | undefined {
  const { pull, who } = facts;
  if (!facts.agentsOn) return { kind: 'skipped', reason: 'agents are off here' };
  if (pull.state !== 'open') return { kind: 'skipped', reason: 'the PR is closed' };
  if (pull.draft) {
    return { kind: 'skipped', reason: 'the PR is a draft; the review starts when it is ready' };
  }
  if (reviewOfHead(facts.reviews, who.reviewer, pull.headSha) !== undefined) {
    return { kind: 'skipped', reason: 'it already reviewed the head' };
  }
  if (waitsForPerson(facts)) return { kind: 'needs-human' };
  const author = { login: pull.author, association: pull.association };
  if (pull.author !== DEPENDABOT && !isTrusted(author, who)) {
    return { kind: 'skipped', reason: "the PR's author is not a member or collaborator" };
  }
  return undefined;
}

/** The lines of the head each changed file's diff shows, where an inline comment can sit. */
export function diffLines(
  files: readonly PullFile[],
): Map<string, { start: number; end: number }[]> {
  const lines = new Map<string, { start: number; end: number }[]>();
  for (const file of files) {
    const change = file.status === 'removed' ? undefined : fileChange(file);
    if (file.patch !== undefined && change !== undefined) lines.set(file.path, [...change.added]);
  }
  return lines;
}

/** Findings that can be inline comments, on a line the diff shows; the rest stay in the body. */
export function inlineComments(
  findings: readonly Finding[],
  files: readonly PullFile[],
): ReviewComment[] {
  const lines = diffLines(files);
  return findings.flatMap((f) => {
    const { path, line } = f;
    if (path === undefined || line === undefined) return [];
    const ranges = lines.get(path) ?? [];
    return ranges.some((r) => r.start <= line && line <= r.end)
      ? [{ path, line, body: clip(defused(f.body), COMMENT_MAX) }]
      : [];
  });
}

type Judged = {
  readonly verdict: Verdict;
  readonly summary: string;
  readonly findings: readonly Finding[];
};

async function contentsAtHead(gh: GitHub, facts: ReviewerFacts): Promise<PromptInput['contents']> {
  const contents: { path: string; text: string }[] = [];
  let budget: number = LIMITS.contents;
  const candidates = readable(facts.files).filter((f) => f.status !== 'removed');
  for (const file of candidates.slice(0, FETCHED_FILES)) {
    const text = await readFileAt(gh, facts.repo, file.path, facts.pull.headSha);
    if (text === undefined || text.length > LIMITS.file || text.length > budget) continue;
    budget -= text.length;
    contents.push({ path: file.path, text });
  }
  return contents;
}

async function askModel(
  gh: GitHub,
  facts: ReviewerFacts,
  deps: ReviewerDeps,
): Promise<ModelResult> {
  const [rubric, engineering, claudeMd, contents] = await Promise.all([
    deps.rubric(),
    deps.engineering(),
    readFileAt(gh, facts.repo, 'CLAUDE.md', facts.pull.baseRef),
    contentsAtHead(gh, facts),
  ]);
  const { issue } = facts;
  const prompt = buildPrompt({
    repo: facts.repo,
    pull: facts.pull,
    files: facts.files,
    issue:
      issue === undefined
        ? undefined
        : { number: issue.number, title: issue.title, body: issue.body },
    contents,
    rubric,
    engineering,
    claudeMd,
  });
  try {
    return await deps.model.review(prompt);
  } catch {
    return { ok: false, reason: 'the model run did not finish' };
  }
}

async function judge(
  gh: GitHub,
  facts: ReviewerFacts,
  deps: ReviewerDeps,
): Promise<Judged | string> {
  const tooLarge = oversize(facts.files, facts.pull.changedFiles);
  if (tooLarge !== undefined) {
    const finding = `${tooLarge} Split it into smaller PRs, each closing its own issue.`;
    return {
      verdict: 'REQUEST_CHANGES',
      summary: 'This PR is too large to review.',
      findings: [{ body: finding }],
    };
  }
  const result = await askModel(gh, facts, deps);
  if (!result.ok) return result.reason;
  const { verdict, summary, comments } = result.answer;
  return { verdict, summary, findings: comments };
}

async function submit(
  gh: GitHub,
  facts: ReviewerFacts,
  judged: Judged,
  body: string,
): Promise<Review> {
  const review = {
    commitId: facts.pull.headSha,
    event: judged.verdict,
    body,
    comments: inlineComments(judged.findings, facts.files),
  };
  try {
    return await submitReview(gh, facts.repo, facts.pull.number, review);
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 422) || review.comments.length === 0) {
      throw error;
    }
    return submitReview(gh, facts.repo, facts.pull.number, { ...review, comments: [] });
  }
}

/** Reviews the head when it should, and submits the verdict as a real review. */
export async function runReviewer(
  gh: GitHub,
  facts: ReviewerFacts,
  deps: ReviewerDeps,
): Promise<ReviewerRun> {
  const skip = notToReview(facts);
  if (skip !== undefined) return skip;
  const judged = await judge(gh, facts, deps);
  if (typeof judged === 'string') return { kind: 'no-verdict', reason: judged };
  const prior = requestedRounds(facts.reviews, facts.who.reviewer);
  const header = { verdict: judged.verdict, round: prior + 1, findings: judged.findings.length };
  const body = reviewBody(header, judged.summary, judged.findings);
  if (judged.verdict === 'REQUEST_CHANGES' && prior >= MAX_ROUNDS) {
    await addLabels(gh, facts.repo, facts.issue?.number ?? facts.pull.number, [NEEDS_HUMAN]);
    return { kind: 'needs-human', body };
  }
  return { kind: 'reviewed', review: await submit(gh, facts, judged, body) };
}
