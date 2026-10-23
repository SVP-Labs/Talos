import { describe, expect, it } from 'vitest';
import { defused, headerLine, parseHeader, reviewBody } from './header.js';
import { reviewerVerdict } from '../status/markers.js';

describe('the talos-review/1 header', () => {
  it('is the first line, in the grammar Thea and talos status read', () => {
    const line = headerLine({ verdict: 'REQUEST_CHANGES', round: 1, findings: 3 });
    expect(line).toBe('talos-review/1 verdict=REQUEST_CHANGES round=1 findings=3');
    expect(reviewerVerdict({ state: 'CHANGES_REQUESTED', body: `${line}\n\nmore` })).toEqual({
      verdict: 'REQUEST_CHANGES',
      round: 1,
      findings: 3,
    });
  });

  it('reads back what it writes', () => {
    const header = { verdict: 'APPROVE', round: 3, findings: 0 } as const;
    expect(parseHeader(`${headerLine(header)}\n\nLooks right.`)).toEqual(header);
  });

  it.each([
    '',
    'LGTM',
    'talos-review/1 verdict=COMMENT round=1 findings=0',
    'talos-review/2 verdict=APPROVE round=1 findings=0',
    'talos-review/1 verdict=APPROVE round=1',
    'x talos-review/1 verdict=APPROVE round=1 findings=0',
    'talos-review/1 verdict=APPROVE round=1 findings=0 extra=1',
  ])('reads no header from %j', (body) => {
    expect(parseHeader(body)).toBeUndefined();
  });

  it('reads the first line only, with its line ending', () => {
    expect(parseHeader('talos-review/1 verdict=APPROVE round=2 findings=1\r\nmore')?.round).toBe(2);
    expect(
      parseHeader('Summary\ntalos-review/1 verdict=APPROVE round=1 findings=0'),
    ).toBeUndefined();
  });
});

describe('reviewBody', () => {
  it('lists the findings under the summary, each on one line', () => {
    const body = reviewBody(
      { verdict: 'REQUEST_CHANGES', round: 2, findings: 2 },
      'Two problems.\nSee below.',
      [{ path: 'src/a.ts', line: 12, body: 'Unchecked\nerror.' }, { body: 'The PR is too large.' }],
    );
    expect(body).toBe(
      [
        'talos-review/1 verdict=REQUEST_CHANGES round=2 findings=2',
        '',
        'Two problems. See below.',
        '',
        '- `src/a.ts:12` Unchecked error.',
        '- The PR is too large.',
      ].join('\n'),
    );
  });

  it('caps the list at 20 and clips each finding and the summary', () => {
    const findings = Array.from({ length: 23 }, (_, i) => ({
      path: `f${i}.ts`,
      body: 'x'.repeat(300),
    }));
    const body = reviewBody(
      { verdict: 'REQUEST_CHANGES', round: 1, findings: 23 },
      's'.repeat(500),
      findings,
    );
    const lines = body.split('\n');
    expect(lines[2]).toHaveLength(400);
    expect(lines.filter((l) => l.startsWith('- `'))).toHaveLength(20);
    expect(lines.at(-1)).toBe('- and 3 more');
    expect(lines[4]).toBe(`- \`f0.ts\` ${'x'.repeat(199)}…`);
  });

  it('writes no list for a clean approval', () => {
    expect(reviewBody({ verdict: 'APPROVE', round: 1, findings: 0 }, 'Fine.', [])).toBe(
      'talos-review/1 verdict=APPROVE round=1 findings=0\n\nFine.',
    );
  });

  it("keeps a path's backticks from breaking out of its code span", () => {
    const body = reviewBody({ verdict: 'REQUEST_CHANGES', round: 1, findings: 1 }, 'x', [
      { path: 'a`b.ts', body: 'y' },
    ]);
    expect(body).toContain("- `a'b.ts` y");
  });
});

describe('defused', () => {
  it('breaks mentions without changing how they read', () => {
    expect(defused('ask @SvenPGH or @org/team')).toBe('ask @\u200BSvenPGH or @\u200Borg/team');
    expect(defused('mail a@b.com and `@scope/pkg`')).toBe('mail a@b.com and `@scope/pkg`');
    expect(defused('@start')).toBe('@\u200Bstart');
  });

  it('takes out the approval marker and control characters', () => {
    expect(defused(`Talos-Approve card ${'a'.repeat(40)}`)).toBe(
      `talos approve card ${'a'.repeat(40)}`,
    );
    expect(defused('a\u0000b\u001Bc\td\ne')).toBe('abc\td\ne');
  });
});
