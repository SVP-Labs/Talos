import { describe, expect, it } from 'vitest';
import {
  debtCandidates,
  debtIssue,
  fileDebtIssues,
  isDeadCode,
  issuable,
  pickDebtIssues,
  WEEKLY_BATCH,
} from './debt-issues.js';
import type { DebtFinding } from './debt-report.js';
import { judgeReadiness } from './readiness.js';
import { readMarker, type TalosIssue } from './talos-issues.js';
import { finding, reportOf } from './test/findings.js';
import { identities } from '../github/identities.js';
import { affectedPaths } from '../ticket/sections.js';
import { FakeGitHub } from '../ticket/test/fake-github.js';

const who = identities({});

function debt(overrides: Partial<DebtFinding>): DebtFinding {
  return {
    rule: 'eslint/complexity',
    check: 'ts/lint',
    policy: 'standard',
    file: 'src/a.ts',
    line: 1,
    key: null,
    message: 'm',
    fingerprint: 'f',
    ...overrides,
  };
}

function existing(fields: Record<string, string>, extra: Partial<TalosIssue> = {}): TalosIssue {
  return {
    number: 1,
    title: '',
    body: '',
    state: 'open',
    stateReason: undefined,
    labels: [],
    author: who.reviewer,
    association: 'NONE',
    createdAt: '2026-10-01T00:00:00Z',
    closedAt: undefined,
    isPull: false,
    fields,
    ...extra,
  };
}

describe('isDeadCode', () => {
  it("recognises a dead-code check's findings and dead-code tools' rules", () => {
    expect(isDeadCode({ check: 'ts/dead-code', rule: 'knip/exports' })).toBe(true);
    expect(isDeadCode({ check: 'py/deadcode', rule: 'x' })).toBe(true);
    expect(isDeadCode({ check: 'x', rule: 'vulture/unused-function' })).toBe(true);
    expect(isDeadCode({ check: 'x', rule: 'cargo-machete/unused' })).toBe(true);
    expect(isDeadCode({ check: 'x', rule: 'rustc/dead_code' })).toBe(true);
    expect(isDeadCode({ check: 'ts/lint', rule: 'eslint/complexity' })).toBe(false);
  });
});

describe('issuable', () => {
  it('takes standard and lost findings in a file a ticket can name', () => {
    expect(issuable(debt({}))).toBe(true);
    expect(issuable(debt({ policy: 'lost' }))).toBe(true);
  });

  it('leaves out what has another home or no file', () => {
    expect(issuable(debt({ policy: 'always' }))).toBe(false);
    expect(issuable(debt({ policy: 'info' }))).toBe(false);
    expect(issuable(debt({ check: 'configs/drift' }))).toBe(false);
    expect(issuable(debt({ file: null }))).toBe(false);
    expect(issuable(debt({ file: 'a b.ts' }))).toBe(false);
    expect(issuable(debt({ file: 'a`b.ts' }))).toBe(false);
  });
});

describe('debtCandidates', () => {
  it('groups by file: dead code first, then the most findings, then by path', () => {
    const report = reportOf([
      finding('eslint/complexity', 'src/z.ts'),
      finding('eslint/complexity', 'src/m.ts'),
      finding('eslint/max-depth', 'src/m.ts'),
      finding('knip/exports', 'src/dead.ts', { check: 'ts/dead-code' }),
      finding('knip/exports', 'src/mixed.ts', { check: 'ts/dead-code' }),
      finding('eslint/complexity', 'src/mixed.ts'),
      finding('eslint/complexity', 'src/a.ts'),
    ]);
    const candidates = debtCandidates(report);
    expect(candidates.map((c) => [c.file, c.kind, c.findings.length])).toEqual([
      ['src/dead.ts', 'dead-code', 1],
      ['src/m.ts', 'other', 2],
      ['src/mixed.ts', 'other', 2],
      ['src/a.ts', 'other', 1],
      ['src/z.ts', 'other', 1],
    ]);
  });

  it('fingerprints the set of findings, whatever their order', () => {
    const a = debtCandidates(reportOf([finding('r/1', 'x.ts'), finding('r/2', 'x.ts')]))[0];
    const b = debtCandidates(reportOf([finding('r/2', 'x.ts'), finding('r/1', 'x.ts')]))[0];
    const c = debtCandidates(reportOf([finding('r/1', 'x.ts')]))[0];
    expect(a?.digest).toBe(b?.digest);
    expect(a?.digest).not.toBe(c?.digest);
  });
});

describe('pickDebtIssues', () => {
  const report = reportOf(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => finding('r/1', `src/${n}.ts`)));
  const candidates = debtCandidates(report);

  it(`files at most ${WEEKLY_BATCH} a week`, () => {
    expect(pickDebtIssues(candidates, []).map((c) => c.file)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
      'src/e.ts',
    ]);
  });

  it('skips files with an open issue, and findings the owner declined', () => {
    const declined = candidates.find((c) => c.file === 'src/b.ts')?.digest ?? '';
    const picks = pickDebtIssues(candidates, [
      existing({ file: 'src/a.ts', findings: 'old' }),
      existing({ file: 'src/b.ts', findings: declined }, { state: 'closed', stateReason: 'not_planned' }),
      existing({ file: 'src/c.ts', findings: 'other' }, { state: 'closed', stateReason: 'not_planned' }),
      existing({ file: 'src/d.ts', findings: 'x' }, { state: 'closed', stateReason: 'completed' }),
    ]);
    expect(picks.map((c) => c.file)).toEqual(['src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts']);
  });
});

describe('debtIssue', () => {
  const [candidate] = debtCandidates(
    reportOf([
      finding('eslint/complexity', 'src/a.ts', { message: 'too complex | @alice <b>x</b> `code`' }),
      ...Array.from({ length: 34 }, (_, i) => finding(`r/${i}`, 'src/a.ts')),
    ]),
  );

  it('is ready by construction, naming exactly its file', () => {
    if (candidate === undefined) throw new Error('no candidate');
    const draft = debtIssue(candidate);
    expect(draft.labels).toEqual(['debt/other', 'status/ready', 'ai/eligible', 'priority/p3']);
    expect(judgeReadiness({ body: draft.body, labels: draft.labels, briefsDir: 'docs', briefs: new Map() })).toEqual({
      ready: true,
      problems: [],
    });
    expect(affectedPaths(draft.body)).toEqual(['src/a.ts']);
    expect(readMarker(draft.body, 'debt')).toEqual({ file: 'src/a.ts', findings: candidate.digest });
    expect(draft.title).toBe('Debt in src/a.ts (35 findings)');
  });

  it('lists at most 30 findings, as inert text', () => {
    if (candidate === undefined) throw new Error('no candidate');
    const { body } = debtIssue(candidate);
    expect(body).toContain("`too complex \\| @alice <b>x</b> 'code'`");
    expect(body).toContain('And 5 more: `talos debt --out debt.json` lists them all.');
    expect(body.split('\n').filter((l) => /^\| (\d|—) \|/.test(l))).toHaveLength(30);
  });

  it('labels dead code as such', () => {
    const [dead] = debtCandidates(reportOf([finding('knip/exports', 'src/d.ts', { check: 'ts/dead-code' })]));
    if (dead === undefined) throw new Error('no candidate');
    expect(debtIssue(dead)).toMatchObject({ title: 'Dead code in src/d.ts (1 finding)', labels: ['debt/dead-code', 'status/ready', 'ai/eligible', 'priority/p3'] });
  });
});

describe('fileDebtIssues', () => {
  it('files the batch as the reviewer and skips what it filed before', async () => {
    const fake = new FakeGitHub();
    const report = reportOf([
      finding('r/1', 'src/a.ts'),
      finding('r/1', 'src/b.ts'),
      finding('knip/x', 'src/c.ts', { check: 'ts/dead-code' }),
    ]);
    const gh = fake.client('talos-reviewer[bot]');
    expect(await fileDebtIssues(gh, { repo: 'o/r', who }, report)).toEqual({ filed: 3, candidates: 3 });
    const filed = [...fake.issues.values()];
    expect(filed.map((i) => [i.user, i.labels[0]])).toEqual([
      ['talos-reviewer[bot]', 'debt/dead-code'],
      ['talos-reviewer[bot]', 'debt/other'],
      ['talos-reviewer[bot]', 'debt/other'],
    ]);
    expect(await fileDebtIssues(gh, { repo: 'o/r', who }, report)).toEqual({ filed: 0, candidates: 3 });
  });

  it("files again for a file whose look-alike issue someone else wrote", async () => {
    const fake = new FakeGitHub();
    fake.addIssue({ number: 1, labels: ['debt/other'], body: '<!-- talos-debt/1 file=src/a.ts findings=x -->', user: 'SvenPGH' });
    const result = await fileDebtIssues(fake.client(), { repo: 'o/r', who }, reportOf([finding('r/1', 'src/a.ts')]));
    expect(result.filed).toBe(1);
  });
});
