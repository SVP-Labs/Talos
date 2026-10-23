import { describe, expect, it } from 'vitest';
import { checkArgs, scopeToTiers } from './check.js';
import { UsageError } from './io.js';
import type { Tier } from '../core/check.js';
import type { GatePlan } from '../engine/plan.js';

describe('talos check: flags', () => {
  it('takes --json, and --commits to judge every commit as a ready PR is judged', () => {
    expect(checkArgs(['--json'])).toEqual({
      json: true,
      commits: false,
      verbose: false,
    });
    expect(checkArgs(['--json', '--commits'])).toMatchObject({ json: true, commits: true });
    expect(checkArgs(['--base', 'origin/main', '--only', 'ts/lint'])).toMatchObject({
      base: 'origin/main',
      only: 'ts/lint',
      json: false,
    });
  });

  it('takes --tiers, which the pre-push hook passes', () => {
    expect(checkArgs(['--tiers', 'commit'])).toMatchObject({ tiers: 'commit' });
  });

  it('refuses a flag it does not know before anything runs', () => {
    expect(() => checkArgs(['--json', '--fix'])).toThrow(UsageError);
    expect(() => checkArgs(['src'])).toThrow(UsageError);
  });
});

describe('talos check: --tiers', () => {
  const run = (sha: string, tiers: readonly Tier[]): GatePlan['runs'][number] => ({
    sha,
    tiers,
    os: 'linux',
    langs: ['ts'],
    php: '',
  });
  const [base, middle, head] = ['b'.repeat(40), 'm'.repeat(40), 'h'.repeat(40)];
  const plan: GatePlan = {
    mode: 'ready',
    base,
    head,
    commits: [middle, head],
    runs: [run(base, ['commit', 'head']), run(middle, ['commit']), run(head, ['commit', 'head'])],
  };

  it('keeps only the tiers asked for, on every run', () => {
    const scoped = scopeToTiers(plan, ['commit']);
    expect(scoped.runs.map((r) => r.tiers)).toEqual([['commit'], ['commit'], ['commit']]);
  });

  it('drops a run left with no tier', () => {
    expect(scopeToTiers(plan, ['head']).runs.map((r) => r.sha)).toEqual([base, head]);
  });
});
