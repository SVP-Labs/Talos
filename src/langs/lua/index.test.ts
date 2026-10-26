import { describe, expect, it } from 'vitest';
import { luaPack, NO_MUTATION } from './index.js';
import { parseConfig } from '../../config/load.js';
import { repoFacts } from '../../repo/facts.js';

describe('the Lua pack', () => {
  it('has its checks in their tiers', () => {
    const own = luaPack.checks.filter((c) => !['lua/tests', 'lua/coverage'].includes(c.id));
    expect(own.map((c) => [c.id, c.tier])).toEqual([
      ['lua/format', 'commit'],
      ['lua/lint', 'commit'],
      ['lua/types', 'commit'],
      ['lua/deadcode', 'commit'],
      ['lua/config-strength', 'head'],
      ['lua/toolchain', 'head'],
      ['lua/mutation', 'head'],
    ]);
  });

  it('marks mutation N/A, and skips a component without Lua', () => {
    const config = parseConfig('name: T\nprefix: T\ncomponents:\n  - { lang: lua }\n');
    const component = config.components[0];
    if (component === undefined) throw new Error('no component');
    const ctx = {
      config,
      component,
      side: 'alone',
      tiers: ['head'],
      facts: repoFacts(['a.lua'], []),
    } as const;
    const byId = new Map(luaPack.checks.map((c) => [c.id, c]));
    expect(byId.get('lua/mutation')?.applies(ctx)).toEqual({ applies: false, reason: NO_MUTATION });
    expect(byId.get('lua/lint')?.applies(ctx)).toEqual({ applies: true });
    const empty = { ...ctx, facts: repoFacts(['README.md'], []) };
    expect(byId.get('lua/lint')?.applies(empty)).toMatchObject({ applies: false });
  });
});
