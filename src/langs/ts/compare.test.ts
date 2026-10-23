import { describe, expect, it } from 'vitest';
import { weakerFlags, weakerRules, splitLimit } from './compare.js';
import { TSC_FLAGS } from './configs/tsconfig.js';

describe('splitLimit', () => {
  it('finds the limit in a number or an object', () => {
    expect(splitLimit([12])).toEqual({ limit: 12, rest: [] });
    expect(splitLimit([{ max: 60, skipComments: true }])).toEqual({
      limit: 60,
      rest: [{ skipComments: true }],
    });
    expect(splitLimit([{ code: 100 }])).toEqual({ limit: 100, rest: [] });
    expect(splitLimit(['always'])).toEqual({ rest: ['always'] });
  });
});

describe('weakerRules', () => {
  const base = {
    complexity: [2, 12],
    'max-lines': [2, { max: 400, skipBlankLines: true, skipComments: true }],
    '@stylistic/max-len': [2, { code: 100, ignoreUrls: true }],
    eqeqeq: [2, 'always', { null: 'ignore' }],
    'no-console': [0],
  };

  it('accepts the base itself and anything stricter', () => {
    expect(weakerRules(base, base)).toEqual([]);
    const stricter = {
      ...base,
      complexity: [2, 10],
      'max-lines': [2, { max: 300, skipBlankLines: false, skipComments: true }],
      '@stylistic/max-len': [2, { code: 100, ignoreUrls: false }],
      'no-console': [2],
    };
    expect(weakerRules(base, stricter)).toEqual([]);
  });

  it('reports a rule turned off, made a warning, loosened or changed', () => {
    const weaker = {
      complexity: [2, 15],
      'max-lines': [1, { max: 400, skipBlankLines: true, skipComments: true }],
      '@stylistic/max-len': [2, { code: 100, ignoreUrls: true, ignoreComments: true }],
      eqeqeq: [2, 'smart'],
    };
    expect(weakerRules(base, weaker).map((w) => [w.subject, w.kind])).toEqual([
      ['complexity', 'limit'],
      ['max-lines', 'severity'],
      ['@stylistic/max-len', 'options'],
      ['eqeqeq', 'options'],
    ]);
    expect(weakerRules({ complexity: ['error', 12] }, {})).toEqual([
      { subject: 'complexity', kind: 'off', how: 'turns off complexity' },
    ]);
  });
});

describe('weakerFlags', () => {
  it('wants every base flag, and no strict-family flag turned off', () => {
    expect(weakerFlags({ ...TSC_FLAGS })).toEqual([]);
    const weaker = { ...TSC_FLAGS, noUncheckedIndexedAccess: false, strictNullChecks: false };
    expect(weakerFlags(weaker).map((w) => w.subject)).toEqual([
      'noUncheckedIndexedAccess',
      'strictNullChecks',
    ]);
    const { checkJs: _, ...missing } = TSC_FLAGS;
    expect(weakerFlags(missing).map((w) => w.how)).toEqual(['does not set checkJs to true']);
  });
});
