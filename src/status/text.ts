import type { PullRequestStatus, RepoStatus, ReviewerVerdict, Status } from './schema.js';

function short(sha: string): string {
  return sha.slice(0, 12);
}

function day(timestamp: string | null): string {
  return timestamp === null ? 'unknown' : timestamp.slice(0, 10);
}

function more(total: number, shown: number): string {
  return total > shown ? `, and ${total - shown} more` : '';
}

function reviewerText(reviewer: ReviewerVerdict | null): string {
  if (reviewer === null) return '';
  const round = reviewer.round === null ? '' : ` round ${reviewer.round}`;
  return `, reviewer ${reviewer.verdict}${round}`;
}

function prLine(pr: PullRequestStatus): string {
  const checks = `gate ${pr.gate}, review ${pr.review}${reviewerText(pr.reviewer)}`;
  const merge = pr.automerge ? ', auto-merge on' : '';
  return `    #${pr.number} ${pr.stage}: ${checks}${merge} · ${pr.title}`;
}

function header(status: RepoStatus): string {
  const pin =
    status.pin === null
      ? 'no pin'
      : `Talos ${status.pin.version ?? '?'} (${short(status.pin.sha)}, ${status.pin.source})`;
  const agents = status.agents ? 'agents on' : 'agents off';
  return `${status.repo} · ${status.channel ?? 'no channel'} · ${pin} · ${agents}`;
}

function repoText(status: RepoStatus): string[] {
  const lines = [header(status)];
  if (status.main !== null) {
    const { main } = status;
    lines.push(`  ${main.branch} ${short(main.sha)}: gate ${main.gate}, review ${main.review}`);
  }
  lines.push(
    `  claims: ${status.claims.total}${more(status.claims.total, status.claims.items.length)}`,
  );
  for (const claim of status.claims.items) {
    const pr = claim.pr === null ? '' : `, PR #${claim.pr}`;
    lines.push(`    ${claim.branch} by ${claim.by ?? 'unknown'} since ${day(claim.since)}${pr}`);
  }
  lines.push(`  open PRs: ${status.prs.total}${more(status.prs.total, status.prs.items.length)}`);
  lines.push(...status.prs.items.map(prLine));
  lines.push(`  security: ${status.security.open} open`);
  for (const issue of status.security.top) {
    lines.push(`    #${issue.number} ${issue.priority ?? 'p?'} · ${issue.title}`);
  }
  const drift =
    status.drift.last === null
      ? 'no report yet'
      : `last #${status.drift.last.number} ${day(status.drift.last.date)} (${status.drift.last.state})`;
  lines.push(`  debt: ${status.debt.open} open · drift: ${status.drift.open} open, ${drift}`);
  lines.push(...status.problems.map((problem) => `  problem: ${problem}`));
  return lines;
}

/** `talos status` for a person: one block per repository. */
export function statusText(statuses: readonly Status[]): string {
  const blocks = statuses.map((status) =>
    'error' in status ? `${status.repo}: ${status.error}` : repoText(status).join('\n'),
  );
  return `${blocks.join('\n\n')}\n`;
}
