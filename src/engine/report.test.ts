import { describe, expect, it } from 'vitest';
import { annotations, markdownSummary, textReport } from './report.js';
import type { EngineFault, Located, Verdict } from './verdict.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function located(overrides: Partial<Located> = {}): Located {
  return {
    rule: 'eslint/complexity',
    message: 'Function has a complexity of 14.',
    location: { file: 'src/a.ts', line: 7 },
    check: 'ts/lint',
    fingerprint: 'f',
    policy: 'standard',
    isNew: true,
    blocking: true,
    why: 'new',
    sha: SHA,
    ...overrides,
  };
}

const fault: EngineFault = {
  check: 'py/types',
  tier: 'commit',
  status: 'error',
  reason: 'basedpyright crashed',
  durationMs: 3,
  findings: [],
  sha: SHA,
  os: 'macos',
};

/** The finding with no place in the code, as a package advisory has. */
function unplaced(finding: Located): Located {
  const { location: _location, ...rest } = finding;
  return rest;
}

function verdictOf(findings: readonly Located[], faults: readonly EngineFault[] = []): Verdict {
  return { findings, blocking: findings.filter((f) => f.blocking), faults };
}

describe('textReport', () => {
  it('lists engine errors, then each blocking finding with its commit and place, then counts', () => {
    const existing = located({ blocking: false, why: 'existing', fingerprint: 'e' });
    const changed = unplaced(
      located({ why: 'changed-line', rule: 'osv/GHSA-1', message: 'A vulnerable package.' }),
    );
    const text = textReport(verdictOf([located(), changed, existing], [fault]));
    expect(text).toBe(
      [
        'ENGINE ERROR py/types at 0123456789ab (macos): basedpyright crashed',
        '0123456789ab src/a.ts:7 eslint/complexity: Function has a complexity of 14.',
        '0123456789ab  osv/GHSA-1 (changed-line): A vulnerable package.',
        '2 blocking finding(s), 1 existing or informational, 1 engine error(s)',
        '',
      ].join('\n'),
    );
  });

  it('says only the counts when nothing blocks', () => {
    expect(textReport(verdictOf([]))).toBe(
      '0 blocking finding(s), 0 existing or informational, 0 engine error(s)\n',
    );
  });

  it('leaves a fault without a reason blank after the colon', () => {
    const { reason: _reason, ...silent } = fault;
    expect(textReport(verdictOf([], [silent]))).toContain(
      'ENGINE ERROR py/types at 0123456789ab (macos): \n',
    );
  });
});

describe('annotations', () => {
  it('writes one error command per blocking finding, escaping what GitHub would misread', () => {
    const finding = located({
      rule: 'a:b,c',
      message: '100% sure\r\nSecond line',
      location: { file: 'src/x,y.ts', line: 2, endLine: 4 },
    });
    expect(annotations(verdictOf([finding]))).toBe(
      '::error file=src/x%2Cy.ts,line=2,endLine=4,title=a%3Ab%2Cc::100%25 sure%0D%0ASecond line\n',
    );
  });

  it('annotates a finding without a place with its title only', () => {
    expect(annotations(verdictOf([unplaced(located())]))).toBe(
      '::error title=eslint/complexity::Function has a complexity of 14.\n',
    );
  });

  it('stops at the limit and skips what does not block', () => {
    const many = Array.from({ length: 5 }, (_, i) => located({ fingerprint: String(i) }));
    const quiet = located({ blocking: false });
    expect(
      annotations(verdictOf([...many, quiet]), 3)
        .split('\n')
        .filter(Boolean),
    ).toHaveLength(3);
    expect(annotations(verdictOf([quiet]))).toBe('');
  });
});

describe('markdownSummary', () => {
  it('heads with the status and tabulates engine errors and blocking findings', () => {
    const piped = located({ message: 'a | b\nc', location: { file: 'src/p|q.ts', line: 1 } });
    const summary = markdownSummary(verdictOf([piped, located({ blocking: false })], [fault]));
    expect(summary).toBe(
      [
        '## Talos: engine-error',
        '',
        '### Engine errors',
        '',
        '- **py/types** at 0123456789ab (macos): basedpyright crashed',
        '',
        '| commit | where | rule | why | message |',
        '| --- | --- | --- | --- | --- |',
        String.raw`| 0123456789ab | src/p\|q.ts:1 | eslint/complexity | new | a \| b c |`,
        '',
        '1 blocking, 1 existing or informational.',
        '',
      ].join('\n'),
    );
  });

  it('is a heading and a count when the gate is green', () => {
    expect(markdownSummary(verdictOf([]))).toBe(
      '## Talos: green\n\n0 blocking, 0 existing or informational.\n',
    );
  });
});
