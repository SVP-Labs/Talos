import type { Finding } from '../../core/finding.js';
import { avoidedWords, type GlossaryEntry } from '../../docs/glossary.js';

export type CommitFacts = {
  readonly sha: string;
  readonly subject: string;
  readonly authorEmail: string;
};

const MAX_SUBJECT = 72;
const DEPENDABOT = /^\d+\+dependabot\[bot\]@users\.noreply\.github\.com$|^support@dependabot\.com$/;

function isDependabot(commit: CommitFacts): boolean {
  return DEPENDABOT.test(commit.authorEmail);
}

/** The ticket a branch names, when it is a ticket branch `<P>-<N>`. */
export function ticketOf(branch: string | undefined, prefix: string): number | undefined {
  const match = branch === undefined ? null : new RegExp(`^${prefix}-(\\d+)$`).exec(branch);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * The commit subject: `[<P>-<N>]: what changed`, at most 72 characters, with the
 * branch's own ticket on a ticket branch, and no word the glossary says to avoid. Dependabot's
 * commits are exempt from the ticket rules, by its account.
 */
export function subjectFindings(
  commit: CommitFacts,
  prefix: string,
  ticket: number | undefined,
  glossary: readonly GlossaryEntry[],
): Finding[] {
  const findings: Finding[] = [];
  const key = `${commit.sha}:${commit.subject}`;
  if (!isDependabot(commit)) {
    const pattern = new RegExp(`^\\[${prefix}-(\\d+)\\]: \\S`);
    const match = pattern.exec(commit.subject);
    if (match === null) {
      findings.push({
        rule: 'commit/subject',
        key,
        policy: 'always',
        message: `${commit.sha.slice(0, 12)}: the subject must read "[${prefix}-<issue>]: what changed", not "${commit.subject}"`,
      });
    } else if (ticket !== undefined && Number(match[1]) !== ticket) {
      findings.push({
        rule: 'commit/ticket',
        key,
        policy: 'always',
        message: `${commit.sha.slice(0, 12)}: on branch ${prefix}-${ticket} every subject starts [${prefix}-${ticket}]:`,
      });
    }
  }
  if (commit.subject.length > MAX_SUBJECT) {
    findings.push({
      rule: 'commit/length',
      key,
      policy: 'always',
      message: `${commit.sha.slice(0, 12)}: the subject is ${commit.subject.length} characters; at most ${MAX_SUBJECT}`,
    });
  }
  for (const hit of avoidedWords(glossary, commit.subject)) {
    findings.push({
      rule: 'glossary/avoid',
      key: `${key}:${hit.word}`,
      policy: 'always',
      message: `${commit.sha.slice(0, 12)}: the subject says "${hit.word}"; the glossary's term is "${hit.instead}"`,
    });
  }
  return findings;
}
