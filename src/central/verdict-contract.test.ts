import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compactVerdict } from '../engine/gate.js';
import type { EngineFault, Located, Verdict } from '../engine/verdict.js';

/**
 * `docs/contracts/verdict.schema.json` is the published shape of `talos.verdict/1`, which the
 * gate uploads as `talos-verdict` and Thea's hub turns into an event. Every verdict
 * `compactVerdict` can produce must satisfy it, and it must refuse what the contract rules out.
 */
const SCHEMA: unknown = JSON.parse(
  readFileSync(new URL('../../docs/contracts/verdict.schema.json', import.meta.url), 'utf8'),
);
const contract = z.fromJSONSchema(SCHEMA as Parameters<typeof z.fromJSONSchema>[0]);

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const CONTEXT = {
  talos: '1.2.0',
  repo: 'SVP-Labs/Thea',
  pr: 42,
  mode: 'ready',
  base: BASE,
  head: HEAD,
};

function located(n: number, extra: Partial<Located> = {}): Located {
  return {
    rule: `eslint/rule-${n % 3}`,
    message: `finding ${n}`,
    location: { file: `src/f${n}.ts`, line: n + 1 },
    check: 'ts/lint',
    fingerprint: `fp${n}`,
    policy: 'standard',
    isNew: true,
    blocking: true,
    why: 'new',
    sha: HEAD,
    ...extra,
  };
}

function fault(n: number, reason: string): EngineFault {
  return {
    check: `ts/check-${n}`,
    tier: 'commit',
    status: 'error',
    reason,
    durationMs: 1,
    findings: [],
    sha: HEAD,
    os: 'windows',
  };
}

const VERDICTS: Record<string, Verdict> = {
  green: { findings: [], blocking: [], faults: [] },
  'red, more than the list holds': (() => {
    const { location: _location, ...first } = located(0, {
      message: 'x'.repeat(500),
      why: 'security',
    });
    const blocking = [first, ...Array.from({ length: 24 }, (_, n) => located(n + 1))];
    const existing = located(99, { blocking: false, why: 'existing', isNew: false });
    return { findings: [...blocking, existing], blocking, faults: [] };
  })(),
  'red, with every text past its cap': (() => {
    const long = (n: number) =>
      located(n, {
        rule: `custom/${n}-${'r'.repeat(200)}`,
        location: { file: `${n}/${'d/'.repeat(200)}f.ts`, line: 1 },
      });
    const blocking = Array.from({ length: 45 }, (_, n) => long(n));
    const flaky = located(0, {
      rule: 'tests/flaky',
      blocking: false,
      why: 'info',
      key: 'k'.repeat(1000),
      location: { file: 'p'.repeat(1000), line: 1 },
    });
    return {
      findings: [...blocking, flaky],
      blocking,
      faults: [{ ...fault(0, 'r'), check: `custom/${'c'.repeat(200)}` }],
    };
  })(),
  'red, past the size an event holds': (() => {
    const odd = (length: number) => '\u0001'.repeat(length);
    const blocking = Array.from({ length: 20 }, (_, n) =>
      located(n, {
        rule: `${n}${odd(200)}`,
        message: odd(500),
        location: { file: odd(500), line: 1 },
      }),
    );
    const flaky = Array.from({ length: 20 }, (_, n) =>
      located(n, {
        rule: 'tests/flaky',
        blocking: false,
        why: 'info',
        key: `${n}${odd(500)}`,
        location: { file: odd(500), line: 1 },
      }),
    );
    return { findings: [...blocking, ...flaky], blocking, faults: [] };
  })(),
  'an engine error with flaky tests': {
    findings: [
      located(1, { rule: 'tests/flaky', blocking: false, why: 'info', key: 'suite > test' }),
    ],
    blocking: [],
    faults: Array.from({ length: 6 }, (_, n) => fault(n, 'r'.repeat(n === 0 ? 1000 : 10))),
  },
};

describe('talos.verdict/1', () => {
  for (const [name, verdict] of Object.entries(VERDICTS)) {
    it(`describes the verdict: ${name}`, () => {
      const compact = compactVerdict(verdict, CONTEXT);
      expect(contract.safeParse(compact).error).toBeUndefined();
      const local = compactVerdict(verdict, {
        talos: '1.2.0',
        mode: 'draft',
        base: BASE,
        head: HEAD,
      });
      expect(contract.safeParse(local).error).toBeUndefined();
    });
  }

  it('lists at most 20 findings and clips messages and reasons', () => {
    const red = compactVerdict(VERDICTS['red, more than the list holds']!, CONTEXT);
    expect(red).toMatchObject({ status: 'red', truncated: true });
    expect(red.blocking as unknown[]).toHaveLength(20);
    expect((red.counts as { byRule: Record<string, number> }).byRule).toEqual({
      'eslint/rule-0': 9,
      'eslint/rule-1': 8,
      'eslint/rule-2': 8,
    });
    const faulty = compactVerdict(VERDICTS['an engine error with flaky tests']!, CONTEXT);
    expect(faulty).toMatchObject({ status: 'engine-error', truncated: true });
    expect(faulty.flaky).toEqual([{ id: 'suite > test', file: 'src/f1.ts' }]);
  });

  it('clips rules, paths, checks and flaky ids, and counts the 40 rules with the most', () => {
    const capped = compactVerdict(VERDICTS['red, with every text past its cap']!, CONTEXT);
    const blocking = z
      .array(z.object({ rule: z.string(), file: z.string() }))
      .parse(capped.blocking);
    expect(blocking.map((f) => [f.rule.length, f.file.length])).toEqual(
      Array.from({ length: 20 }, () => [100, 300]),
    );
    const { byRule } = z.object({ byRule: z.record(z.string(), z.number()) }).parse(capped.counts);
    expect(Object.keys(byRule)).toHaveLength(40);
    expect(Object.keys(byRule).every((rule) => rule.length <= 100)).toBe(true);
    expect(capped.counts).toMatchObject({ blocking: 45 });
    expect(capped.faults).toMatchObject([{ check: `custom/${'c'.repeat(92)}…` }]);
    expect(capped.flaky).toEqual([{ id: `${'k'.repeat(299)}…`, file: `${'p'.repeat(299)}…` }]);
  });

  it('lists no more than fits in 48 KiB, however its text escapes', () => {
    const big = compactVerdict(VERDICTS['red, past the size an event holds']!, CONTEXT);
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(48 * 1024);
    expect(big).toMatchObject({ truncated: true, counts: { blocking: 20 } });
    expect((big.blocking as unknown[]).length).toBeLessThan(20);
  });

  it('refuses what the contract rules out', () => {
    const good = compactVerdict(VERDICTS.green!, CONTEXT);
    const finding = { sha: HEAD, rule: 'r', why: 'new', file: null, line: null, message: '' };
    const counts = { blocking: 0, existing: 0, faults: 0 };
    const rules = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i}`, 1]));
    expect(contract.safeParse({ ...good, counts: { ...counts, byRule: rules(40) } }).success).toBe(
      true,
    );
    const bad: Record<string, unknown>[] = [
      { ...good, schema: 'talos.verdict/2' },
      { ...good, extra: true },
      { ...good, status: 'yellow' },
      { ...good, pr: 0 },
      { ...good, head: 'v1.2.0' },
      {
        ...good,
        blocking: [
          { sha: HEAD, rule: 'r', why: 'new', file: null, line: null, message: 'm'.repeat(201) },
        ],
      },
      {
        ...good,
        blocking: Array.from({ length: 21 }, () => ({
          sha: HEAD,
          rule: 'r',
          why: 'new',
          file: null,
          line: null,
          message: '',
        })),
      },
      { ...good, counts: { blocking: 0, existing: 0, faults: 0 } },
      { ...good, talos: '1'.repeat(51) },
      { ...good, blocking: [{ ...finding, rule: 'r'.repeat(101) }] },
      { ...good, blocking: [{ ...finding, file: 'f'.repeat(301) }] },
      { ...good, counts: { ...counts, byRule: { ['r'.repeat(101)]: 1 } } },
      { ...good, counts: { ...counts, byRule: rules(41) } },
      { ...good, faults: [{ sha: HEAD, os: 'linux', check: 'c'.repeat(101), reason: '' }] },
      { ...good, flaky: [{ id: 'i'.repeat(301), file: null }] },
      { ...good, flaky: [{ id: 'i', file: 'f'.repeat(301) }] },
    ];
    for (const value of bad) expect(contract.safeParse(value).success).toBe(false);
    const { truncated: _truncated, ...missing } = good;
    expect(contract.safeParse(missing).success).toBe(false);
  });
});
