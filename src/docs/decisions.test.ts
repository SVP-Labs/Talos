import { describe, expect, it } from 'vitest';
import { decisionIds, decisionsIn, judgeDecisions, referencesIn } from './decisions.js';

const brief = [
  '# A brief',
  '',
  '## Decisions',
  '',
  '### C1 · One kit',
  '',
  '**Decision:** one kit (C2).',
  '',
  '### C2 · Two channels',
  '',
  'Reversed by: X2',
  '',
  '```markdown',
  '### C9 · Inside a fence, not a decision',
  '```',
].join('\n');

const decisions = [
  '# Decisions',
  '',
  '## X1 · Contracts',
  '',
  'Text citing C1 and C3.',
  '',
  '## X2 · Three channels',
  '',
  '**Reverses:** C2',
].join('\n');

describe('decisionsIn', () => {
  it('reads decision headings and their reversal markers, not fenced examples', () => {
    expect(decisionsIn({ file: 'b.md', text: brief })).toEqual([
      { id: 'C1', file: 'b.md', line: 5, reverses: [], reversedBy: [] },
      { id: 'C2', file: 'b.md', line: 9, reverses: [], reversedBy: [{ id: 'X2', line: 11 }] },
    ]);
    expect(decisionsIn({ file: 'D.md', text: decisions })[1]).toMatchObject({
      id: 'X2',
      reverses: [{ id: 'C2', line: 9 }],
    });
  });

  it('collects every ID', () => {
    expect([...decisionIds([{ file: 'b.md', text: brief }])]).toEqual(['C1', 'C2']);
  });
});

describe('referencesIn', () => {
  const prefixes = new Set(['C', 'X']);
  const refs = (text: string): string[] =>
    referencesIn({ file: 'a.md', text }, prefixes).map((ref) => ref.id);

  it('finds citations with a known prefix, in lists and ranges', () => {
    expect(refs('As C8 says (C3, C15 and C20), and C1 to C34.')).toEqual([
      'C8',
      'C3',
      'C15',
      'C20',
      'C1',
      'C34',
    ]);
    expect(refs('Option A1a of X1, then X12b.')).toEqual(['X1', 'X12']);
  });

  it("leaves other systems' and other people's decisions alone", () => {
    expect(refs("Thea's C8, her C3, Talos C20, C21 and C22, and the LoreLock C5 rule.")).toEqual(
      [],
    );
    expect(refs('**Decision:** Talos C34. Amends C3.')).toEqual(['C3']);
    expect(refs('  Talos C16 lands without one.')).toEqual([]);
  });

  it('skips what only looks like an ID', () => {
    expect(refs('SHA256, UTF8, H1, G3, #C8, path/C8, C8-style, v2.C8, C2.1 and `C9`')).toEqual([]);
    expect(refs('<!-- C9 -->\n```\nC9\n```')).toEqual([]);
  });

  it('reports the line and column', () => {
    expect(referencesIn({ file: 'a.md', text: 'x\n  see C9' }, prefixes)).toEqual([
      { id: 'C9', file: 'a.md', line: 2, column: 7 },
    ]);
  });
});

describe('judgeDecisions', () => {
  const definitions = [
    { file: 'docs/requirements/b.md', text: brief },
    { file: 'DECISIONS.md', text: decisions },
  ];

  it('passes linked reversals and resolved references', () => {
    expect(judgeDecisions(definitions, [{ file: 'README.md', text: 'See C1 and X2.' }])).toEqual(
      [],
    );
  });

  it('reports an unresolved reference, wherever it is', () => {
    expect(judgeDecisions(definitions, [{ file: 'README.md', text: 'See C40.' }])).toEqual([
      {
        rule: 'decisions/unresolved-reference',
        file: 'README.md',
        line: 1,
        column: 5,
        message: 'C40 names no decision in DECISIONS.md or the briefs.',
      },
    ]);
  });

  it('reports a duplicate ID at its later definition', () => {
    const again = { file: 'docs/requirements/c.md', text: '### C1 · Again\n' };
    expect(judgeDecisions([...definitions, again], [])).toEqual([
      expect.objectContaining({
        rule: 'decisions/duplicate-id',
        file: 'docs/requirements/c.md',
        line: 1,
        message: expect.stringContaining('docs/requirements/b.md:5') as unknown,
      }),
    ]);
  });

  it('reports a reversal linked one way, from either side', () => {
    const forward = { file: 'DECISIONS.md', text: '## X3 · New\n\nReverses: C1\n' };
    const backward = { file: 'DECISIONS.md', text: '## X4 · Other\n' };
    const problems = judgeDecisions(
      [
        { file: 'b.md', text: '### C1 · Old\n\n### C5 · Five\n\nReversed by: X4\n' },
        forward,
        backward,
      ],
      [],
    );
    expect(problems.map((p) => [p.rule, p.file, p.line, p.message])).toEqual([
      [
        'decisions/one-way-reversal',
        'b.md',
        5,
        'C5 is reversed by X4, but X4 has no "Reverses: C5" line; link the two both ways.',
      ],
      [
        'decisions/one-way-reversal',
        'DECISIONS.md',
        3,
        'X3 reverses C1, but C1 has no "Reversed by: X3" line; link the two both ways.',
      ],
    ]);
  });
});
