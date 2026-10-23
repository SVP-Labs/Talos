import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { driftCheck, driftFindings, firstDifference } from './drift.js';
import type { RenderedConfig } from './files.js';
import { generatedHeader } from './header.js';
import { commitAll, committedRepo } from './test/git.js';
import { parseConfig } from '../config/load.js';
import type { Pack } from '../core/pack.js';
import { runChecks } from '../engine/run.js';
import { MINIMAL_CONFIG, testEngine, testPlan } from '../testing/engine.js';
import { ownVersion } from '../version/self.js';

const BASE = (version: string): string => `${generatedHeader('#', version, 'tool.project')}a = 1\n`;

const RENDERED: RenderedConfig[] = [
  {
    path: 'tool.cfg',
    content: BASE('2.0.0'),
    extension: { path: 'tool.project', content: '# yours\n' },
  },
  { path: 'apps/x/lint.cfg', content: 'strict = true\n' },
];

function committed(contents: Record<string, string>, others: string[] = []) {
  return {
    paths: new Set([...Object.keys(contents), ...others]),
    contents: new Map(Object.entries(contents)),
  };
}

describe('driftFindings', () => {
  it('finds nothing when the copies match, their version and line endings aside', () => {
    const files = {
      'tool.cfg': BASE('1.0.0').replaceAll('\n', '\r\n'),
      'apps/x/lint.cfg': 'strict = true\n',
    };
    expect(driftFindings(RENDERED, committed(files, ['tool.project']))).toEqual([]);
  });

  it('reports a missing copy, a different one and a missing extension', () => {
    const findings = driftFindings(RENDERED, committed({ 'apps/x/lint.cfg': 'strict = false\n' }));
    expect(findings).toEqual([
      {
        rule: 'config/drift',
        key: 'tool.cfg missing',
        message: 'tool.cfg is missing: run `talos configs` to write it.',
      },
      {
        rule: 'config/missing-extension',
        key: 'tool.project',
        message:
          "tool.project, the project's extension of tool.cfg, is missing: run `talos configs` to create it.",
      },
      {
        rule: 'config/drift',
        key: expect.stringMatching(/^apps\/x\/lint\.cfg [0-9a-f]{16}$/) as string,
        location: { file: 'apps/x/lint.cfg', line: 1 },
        message:
          'apps/x/lint.cfg differs from what Talos renders, from line 1: run `talos configs`.',
      },
    ]);
  });

  it('keys a stale copy by its content, so only an edit makes a new finding', () => {
    const stale = driftFindings(RENDERED, committed({ 'tool.cfg': 'a = 0\n' }, ['tool.project']));
    const same = driftFindings(RENDERED, committed({ 'tool.cfg': 'a = 0\n' }, ['tool.project']));
    const edited = driftFindings(RENDERED, committed({ 'tool.cfg': 'a = 2\n' }, ['tool.project']));
    expect(stale[0]?.key).toBe(same[0]?.key);
    expect(edited[0]?.key).not.toBe(stale[0]?.key);
  });

  it('reports an extension file several bases share once', () => {
    const shared = { path: 'shared.project', content: '' };
    const files: RenderedConfig[] = [
      { path: 'a.cfg', content: 'a\n', extension: shared },
      { path: 'b.cfg', content: 'b\n', extension: shared },
    ];
    const findings = driftFindings(files, committed({ 'a.cfg': 'a\n', 'b.cfg': 'b\n' }));
    expect(findings.map((f) => f.rule)).toEqual(['config/missing-extension']);
  });
});

describe('firstDifference', () => {
  it('names the first line that differs', () => {
    expect(firstDifference('a\nb\nc\n', 'a\nB\nc\n')).toBe(2);
    expect(firstDifference('a\n', 'a\nb\n')).toBe(2);
    expect(firstDifference('', 'a')).toBe(1);
  });
});

const pack: Pack = {
  name: 'fake',
  checks: [],
  generated: [
    {
      path: 'tool.cfg',
      scope: 'repo',
      applies: () => true,
      render: (ctx) => BASE(ctx.version),
      extension: { path: 'tool.project', initial: () => '# yours\n' },
    },
    {
      path: 'lint.cfg',
      scope: 'component',
      langs: ['py'],
      applies: () => true,
      render: () => 'strict = true\n',
    },
  ],
};

describe('configs/drift', () => {
  const config = `${MINIMAL_CONFIG}components:\n  - { lang: py, root: apps/x }\n`;

  it('compares the committed copies, not the working copies prepare rewrote', async () => {
    const { root } = await committedRepo({
      'talos.yml': config,
      'tool.cfg': 'a = 0\n',
      'tool.project': '',
      'apps/x/lint.cfg': 'strict = true\n',
    });
    await writeFile(join(root, 'tool.cfg'), BASE(ownVersion()));
    const sha = await commitAll(root, '[T-1]: Empty');
    await writeFile(join(root, 'tool.cfg'), 'a = 5\n');
    const plan = { ...testPlan(root, ['tool.cfg'], parseConfig(config)), sha };
    const clean = await runChecks(
      testEngine([{ name: 'configs', checks: [driftCheck([pack])] }]),
      plan,
    );
    expect(clean.outcomes[0]).toMatchObject({ check: 'configs/drift', status: 'passed' });
  });

  it('reports drift at the judged commit', async () => {
    const { root, sha } = await committedRepo({ 'talos.yml': config, 'tool.cfg': 'a = 0\n' });
    const plan = { ...testPlan(root, ['tool.cfg'], parseConfig(config)), sha };
    const result = await runChecks(
      testEngine([{ name: 'configs', checks: [driftCheck([pack])] }]),
      plan,
    );
    expect(result.outcomes[0]?.findings.map((f) => [f.rule, f.key?.split(' ')[0]])).toEqual([
      ['config/drift', 'tool.cfg'],
      ['config/missing-extension', 'tool.project'],
      ['config/drift', 'apps/x/lint.cfg'],
    ]);
  });

  it('is an engine error when the commit cannot be read', async () => {
    const { root } = await committedRepo({ 'talos.yml': config });
    const plan = testPlan(root, [], parseConfig(config));
    const result = await runChecks(
      testEngine([{ name: 'configs', checks: [driftCheck([pack])] }]),
      plan,
    );
    expect(result.outcomes[0]).toMatchObject({ status: 'error' });
    expect(result.outcomes[0]?.reason).toMatch(/^could not list commit 000000000000/);
  });

  it('skips when no generated file applies', () => {
    const check = driftCheck([{ name: 'none', checks: [] }]);
    const plan = testPlan('/x', []);
    expect(check.applies({ ...plan, side: 'alone' })).toMatchObject({ applies: false });
  });
});
