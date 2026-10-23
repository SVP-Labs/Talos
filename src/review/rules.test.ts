import { describe, expect, it } from 'vitest';
import { historyRule, type PullText, pullRules, ticketOf, ticketRule } from './rules.js';

const BODY = [
  'Closes #12',
  '',
  '## Problem',
  '',
  'The parser drops trailing commas.',
  '',
  '## Discussion',
  '',
  'Fixing the grammar beats a post-pass.',
  '',
  '## Solution',
  '',
  'The grammar accepts them; a test covers it.',
].join('\n');

function pull(overrides: Partial<PullText> = {}): PullText {
  return {
    author: 'thea-svp[bot]',
    headRef: 'T-12',
    body: BODY,
    prefix: 'T',
    repo: 'o/r',
    closing: [{ number: 12, repo: 'o/r' }],
    ...overrides,
  };
}

describe('ticketOf', () => {
  it('reads <P>-<N> for the project prefix only', () => {
    expect(ticketOf('T-12', 'T')).toBe(12);
    expect(ticketOf('TL-3', 'TL')).toBe(3);
    expect(ticketOf('TL-3', 'T')).toBeUndefined();
    expect(ticketOf('T-0', 'T')).toBeUndefined();
    expect(ticketOf('T-012', 'T')).toBeUndefined();
    expect(ticketOf('t-12', 'T')).toBeUndefined();
    expect(ticketOf('T-12-fix', 'T')).toBeUndefined();
    expect(ticketOf('feature/T-12', 'T')).toBeUndefined();
  });
});

describe('ticketRule', () => {
  it('holds when the ticket branch closes its issue and no other', () => {
    expect(ticketRule(pull())).toEqual({
      met: true,
      line: 'branch T-12 closes #12 and no other issue',
    });
  });

  it('fails a branch that is no ticket', () => {
    expect(ticketRule(pull({ headRef: 'thea/fix-parser' }))).toEqual({
      met: false,
      line: 'branch thea/fix-parser is not a ticket branch T-<N>',
    });
  });

  it('fails a PR that closes no issue, another issue, or more than one', () => {
    expect(ticketRule(pull({ closing: [] })).line).toBe(
      'branch T-12 closes no issue; it must close #12 only',
    );
    expect(ticketRule(pull({ closing: [{ number: 13, repo: 'o/r' }] })).line).toBe(
      'branch T-12 closes #13; it must close #12 only',
    );
    const two = pull({
      closing: [
        { number: 12, repo: 'o/r' },
        { number: 14, repo: 'o/r' },
      ],
    });
    expect(ticketRule(two)).toEqual({
      met: false,
      line: 'branch T-12 closes #12, #14; it must close #12 only',
    });
  });

  it('fails #N of another repository', () => {
    const other = pull({ closing: [{ number: 12, repo: 'o/elsewhere' }] });
    expect(ticketRule(other)).toEqual({
      met: false,
      line: 'branch T-12 closes o/elsewhere#12; it must close #12 only',
    });
  });

  it('compares repository names without case', () => {
    expect(ticketRule(pull({ closing: [{ number: 12, repo: 'O/R' }] })).met).toBe(true);
  });

  it("exempts Dependabot's PRs, by its account only", () => {
    expect(
      ticketRule(
        pull({ author: 'dependabot[bot]', headRef: 'dependabot/npm/x-1.2.3', closing: [] }),
      ),
    ).toEqual({
      met: true,
      line: 'Dependabot: exempt from the ticket rules',
    });
    expect(
      ticketRule(pull({ author: 'renovate[bot]', headRef: 'renovate/x', closing: [] })).met,
    ).toBe(false);
  });
});

describe('historyRule', () => {
  it('holds when Problem, Discussion and Solution each say something', () => {
    expect(historyRule(pull())).toEqual({
      met: true,
      line: 'the PR body has Problem, Discussion and Solution',
    });
  });

  it('fails a missing or empty section', () => {
    expect(historyRule(pull({ body: BODY.replace('## Discussion', '## Notes') }))).toEqual({
      met: false,
      line: "the PR body's Discussion section is missing or empty",
    });
    expect(historyRule(pull({ body: BODY.replace('## Problem', '## Why') })).line).toBe(
      "the PR body's Problem section is missing or empty",
    );
    expect(
      historyRule(pull({ body: BODY.replace('## Problem', '## A').replace('## Solution', '## B') }))
        .line,
    ).toBe("the PR body's Problem and Solution sections are missing or empty");
    expect(historyRule(pull({ body: 'Closes #12' })).line).toBe(
      "the PR body's Problem, Discussion and Solution sections are missing or empty",
    );
  });

  it("counts the template's comments and the forms' placeholder as empty", () => {
    const template = BODY.replace(
      'The grammar accepts them; a test covers it.',
      '<!-- What this PR does -->',
    );
    expect(historyRule(pull({ body: template })).met).toBe(false);
    const unclosed = BODY.replace(
      'The grammar accepts them; a test covers it.',
      '<!-- What this PR',
    );
    expect(historyRule(pull({ body: unclosed })).met).toBe(false);
    expect(
      historyRule(
        pull({ body: BODY.replace('The parser drops trailing commas.', '_No response_') }),
      ).met,
    ).toBe(false);
  });

  it('reads headings of any level, case and trailing colon', () => {
    const body = BODY.replace('## Problem', '### problem:').replace('## Solution', '#### SOLUTION');
    expect(historyRule(pull({ body })).met).toBe(true);
  });

  it("exempts Dependabot's PR text", () => {
    expect(historyRule(pull({ author: 'dependabot[bot]', body: 'Bumps x from 1 to 2.' })).met).toBe(
      true,
    );
  });
});

describe('pullRules', () => {
  it('lists the ticket rule, then the history rule', () => {
    expect(pullRules(pull()).map((c) => c.met)).toEqual([true, true]);
    expect(pullRules(pull({ headRef: 'main', body: '' })).map((c) => c.met)).toEqual([
      false,
      false,
    ]);
  });
});
