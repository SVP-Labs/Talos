import { describe, expect, it } from 'vitest';
import { type Comparison, decide, exitCode, statusOf, type Verdict } from './verdict.js';
import type { Os, Tier } from '../core/check.js';
import type { Reported } from '../core/finding.js';
import type { Outcome, RunResult } from '../core/result.js';

const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);

function reported(fingerprint: string, policy: Reported['policy'] = 'standard'): Reported {
  return {
    rule: `eslint/${fingerprint}`,
    message: `finding ${fingerprint}`,
    location: { file: 'src/a.ts', line: 3 },
    check: 'ts/lint',
    fingerprint,
    policy,
  };
}

function outcome(findings: readonly Reported[], extra: Partial<Outcome> = {}): Outcome {
  return {
    check: 'ts/lint',
    tier: 'commit',
    status: findings.length > 0 ? 'findings' : 'passed',
    durationMs: 1,
    findings,
    ...extra,
  };
}

function result(sha: string, outcomes: readonly Outcome[], os: Os = 'linux'): RunResult {
  return { talos: '0.0.0', sha, tiers: ['commit', 'head'], os, outcomes };
}

function comparison(tier: Tier = 'commit'): Comparison {
  return { sha: HEAD, against: BASE, tier, changes: { files: new Map() } };
}

describe('decide', () => {
  it('blocks what head adds over base, and keeps what base already had as existing', () => {
    const results = [
      result(BASE, [outcome([reported('old')])]),
      result(HEAD, [outcome([reported('old'), reported('fresh')])]),
    ];
    const verdict = decide(results, [comparison()], []);
    expect(verdict.findings.map((f) => [f.fingerprint, f.why, f.blocking, f.sha])).toEqual([
      ['old', 'existing', false, HEAD],
      ['fresh', 'new', true, HEAD],
    ]);
    expect(verdict.blocking.map((f) => f.fingerprint)).toEqual(['fresh']);
    expect(verdict.faults).toEqual([]);
  });

  it('judges everything at head as new when the base never ran that tier', () => {
    const results = [result(HEAD, [outcome([reported('only')])])];
    const verdict = decide(results, [comparison()], []);
    expect(verdict.blocking.map((f) => [f.fingerprint, f.why])).toEqual([['only', 'new']]);
  });

  it('compares nothing for a head that has no run', () => {
    const results = [result(BASE, [outcome([reported('old')])])];
    expect(decide(results, [comparison()], []).findings).toEqual([]);
  });

  it('reads only the compared tier', () => {
    const results = [
      result(HEAD, [
        outcome([reported('commit-tier')]),
        outcome([reported('head-tier')], { tier: 'head' }),
      ]),
    ];
    const verdict = decide(results, [comparison('head')], []);
    expect(verdict.findings.map((f) => f.fingerprint)).toEqual(['head-tier']);
  });

  it('reports a finding every OS found once', () => {
    const findings = [outcome([reported('same')])];
    const results = [result(HEAD, findings, 'linux'), result(HEAD, findings, 'macos')];
    const verdict = decide(results, [comparison(), comparison()], []);
    expect(verdict.findings).toHaveLength(1);
  });

  it('adds commit findings as new and blocking, unless they only inform', () => {
    const commitFindings = [
      { ...reported('subject', 'standard'), check: 'process/commits', sha: HEAD },
      { ...reported('note', 'info'), check: 'process/commits', sha: HEAD },
    ];
    const verdict = decide([], [], commitFindings);
    expect(verdict.findings.map((f) => [f.fingerprint, f.isNew, f.blocking, f.why])).toEqual([
      ['subject', true, true, 'new'],
      ['note', true, false, 'info'],
    ]);
  });

  it('collects every engine error with the commit and OS it happened on', () => {
    const broken = outcome([], { check: 'py/types', status: 'error', reason: 'pyright crashed' });
    const results = [result(HEAD, [broken, outcome([])], 'windows')];
    expect(decide(results, [comparison()], []).faults).toEqual([
      { ...broken, sha: HEAD, os: 'windows' },
    ]);
  });
});

describe('statusOf and exitCode', () => {
  const located = { ...reported('x'), sha: HEAD, isNew: true, blocking: true, why: 'new' as const };
  const fault = { ...outcome([], { status: 'error' }), sha: HEAD, os: 'linux' as const };
  const cases: [string, Verdict, string, number][] = [
    ['nothing', { findings: [], blocking: [], faults: [] }, 'green', 0],
    [
      'only existing',
      { findings: [{ ...located, blocking: false }], blocking: [], faults: [] },
      'green',
      0,
    ],
    ['a blocking finding', { findings: [located], blocking: [located], faults: [] }, 'red', 1],
    [
      'an engine error',
      { findings: [located], blocking: [located], faults: [fault] },
      'engine-error',
      2,
    ],
  ];
  for (const [name, verdict, status, code] of cases) {
    it(`reads ${status} and exits ${code} for ${name}`, () => {
      expect(statusOf(verdict)).toBe(status);
      expect(exitCode(verdict)).toBe(code);
    });
  }
});
