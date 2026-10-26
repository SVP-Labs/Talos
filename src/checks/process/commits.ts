import type { Finding } from '../../core/finding.js';
import { avoidedWords, type GlossaryEntry } from '../../docs/glossary.js';

export type CommitFacts = {
  readonly sha: string;
  readonly subject: string;
  readonly authorEmail: string;
  /**
   * Whether GitHub vouches that a commit in Dependabot's name is Dependabot's: on a PR Dependabot
   * opened, or in the merge queue, which takes a PR only once its own gate passed. Anyone can
   * write the email, so without this it exempts nothing.
   */
  readonly dependabotVouched: boolean;
};

const MAX_SUBJECT = 72;
const DEPENDABOT = /^\d+\+dependabot\[bot\]@users\.noreply\.github\.com$|^support@dependabot\.com$/;

function isDependabot(commit: CommitFacts): boolean {
  return commit.dependabotVouched && DEPENDABOT.test(commit.authorEmail);
}

/** The number `rest` reads where `text` goes on after starting with `lead`. */
function numberAfter(text: string, lead: string, rest: RegExp): number | undefined {
  const digits = text.startsWith(lead) ? rest.exec(text.slice(lead.length))?.[1] : undefined;
  return digits === undefined ? undefined : Number(digits);
}

/**
 * A merge commit, which no governed repository lands: `main` takes rebased commits through the
 * merge queue, and a merge's change against its first parent carries whatever it merged in, so
 * the commit is reported once and judged no further.
 */
export function mergeFinding(sha: string): Finding {
  return {
    rule: 'commit/merge',
    key: `${sha}:merge`,
    policy: 'always',
    message: `${sha.slice(0, 12)}: a merge commit; rebase instead of merging, since main takes no merges`,
  };
}

/** The ticket a branch names, when it is a ticket branch `<P>-<N>`. */
export function ticketOf(branch: string | undefined, prefix: string): number | undefined {
  return branch === undefined ? undefined : numberAfter(branch, `${prefix}-`, /^(\d+)$/);
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
    const number = numberAfter(commit.subject, `[${prefix}-`, /^(\d+)\]: \S/);
    if (number === undefined) {
      findings.push({
        rule: 'commit/subject',
        key,
        policy: 'always',
        message: `${commit.sha.slice(0, 12)}: the subject must read "[${prefix}-<issue>]: what changed", not "${commit.subject}"`,
      });
    } else if (ticket !== undefined && number !== ticket) {
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
