import { describe, expect, it } from 'vitest';
import { runChecks } from './run.js';
import { parseConfig } from '../config/load.js';
import { APPLIES, EngineError, skip } from '../core/check.js';
import type { Pack } from '../core/pack.js';
import { tempRepo, testEngine, testPlan } from '../testing/engine.js';

const pack: Pack = {
  name: 'demo',
  checks: [
    {
      id: 'demo/finds',
      tier: 'commit',
      scope: 'repo',
      title: 'finds',
      applies: () => APPLIES,
      run: () =>
        Promise.resolve([
          { rule: 'demo/x', message: 'bad', location: { file: 'src/a.ts', line: 2 } },
        ]),
    },
    {
      id: 'demo/breaks',
      tier: 'head',
      scope: 'repo',
      title: 'breaks',
      applies: () => APPLIES,
      run: () => Promise.reject(new EngineError('tool output unreadable')),
    },
    {
      id: 'demo/skips',
      tier: 'head',
      scope: 'repo',
      title: 'skips',
      applies: () => skip('nothing to check'),
      run: () => Promise.resolve([]),
    },
    {
      id: 'demo/per-component',
      tier: 'commit',
      scope: 'component',
      langs: ['py'],
      title: 'per component',
      applies: () => APPLIES,
      run: (ctx) =>
        Promise.resolve([{ rule: 'demo/c', message: ctx.component?.root ?? '', key: 'k' }]),
    },
  ],
};

describe('runChecks', () => {
  it('reports findings with fingerprints, faults and skips apart', async () => {
    const root = await tempRepo({ 'src/a.ts': 'one\n  two  \nthree\n' });
    const result = await runChecks(testEngine([pack]), testPlan(root, ['src/a.ts']));
    const byCheck = new Map(result.outcomes.map((o) => [o.check, o]));
    expect(byCheck.get('demo/finds')?.status).toBe('findings');
    expect(byCheck.get('demo/finds')?.findings[0]).toMatchObject({
      policy: 'standard',
      check: 'demo/finds',
    });
    expect(byCheck.get('demo/breaks')).toMatchObject({
      status: 'error',
      reason: 'tool output unreadable',
    });
    expect(byCheck.get('demo/skips')).toMatchObject({
      status: 'skipped',
      reason: 'nothing to check',
    });
  });

  it('runs component checks once per matching component on its OSes', async () => {
    const root = await tempRepo({});
    const config = parseConfig(
      'name: T\nprefix: T\ncomponents:\n  - { lang: py, root: a }\n  - { lang: py, root: b, os: [windows] }\n  - { lang: ts }\n',
    );
    const linux = await runChecks(testEngine([pack]), {
      ...testPlan(root, [], config),
      only: ['demo/per-component'],
    });
    expect(linux.outcomes.map((o) => o.component)).toEqual(['a']);
    const windows = await runChecks(testEngine([pack]), {
      ...testPlan(root, [], config),
      os: 'windows',
      only: ['demo/per-component', 'demo/finds'],
    });
    expect(windows.outcomes.map((o) => [o.check, o.component])).toEqual([
      ['demo/per-component', 'b'],
    ]);
  });
});

describe('runChecks after a failed install', () => {
  it("reports that component's checks as engine errors and leaves the others alone", async () => {
    const root = await tempRepo({});
    const config = parseConfig(
      'name: T\nprefix: T\ncomponents:\n  - { lang: py, root: a }\n  - { lang: py, root: b }\n',
    );
    const result = await runChecks(testEngine([pack]), {
      ...testPlan(root, [], config),
      only: ['demo/per-component'],
      failedInstalls: new Map([['a', 'installing py at a: no uv.lock']]),
    });
    expect(result.outcomes.map((o) => [o.component, o.status, o.reason])).toEqual([
      ['a', 'error', 'installing py at a: no uv.lock'],
      ['b', 'findings', undefined],
    ]);
  });
});
