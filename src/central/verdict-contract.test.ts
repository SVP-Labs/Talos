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

  it('refuses what the contract rules out', () => {
    const good = compactVerdict(VERDICTS.green!, CONTEXT);
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
    ];
    for (const value of bad) expect(contract.safeParse(value).success).toBe(false);
    const { truncated: _truncated, ...missing } = good;
    expect(contract.safeParse(missing).success).toBe(false);
  });
});
