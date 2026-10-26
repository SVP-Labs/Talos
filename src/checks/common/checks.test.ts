import { describe, expect, it } from 'vitest';
import { commonPack } from './index.js';
import { parseConfig } from '../../config/load.js';
import { generatedHeader } from '../../configs/header.js';
import { committedRepo } from '../../configs/test/git.js';
import type { RunResult } from '../../core/result.js';
import { runChecks } from '../../engine/run.js';
import { MINIMAL_CONFIG, testEngine, testPlan } from '../../testing/engine.js';

const TOTAL = `export function total(items: readonly { price: number; qty: number }[]): number {
  let sum = 0;
  for (const item of items) {
    if (item.qty > 0 && item.price > 0) {
      sum += item.price * item.qty;
    } else {
      sum -= 1;
    }
  }
  return Math.round(sum * 100) / 100;
}
`;

async function run(
  files: Readonly<Record<string, string>>,
  only: string[],
  config = MINIMAL_CONFIG,
): Promise<RunResult> {
  const { root, sha } = await committedRepo(files);
  const plan = { ...testPlan(root, Object.keys(files), parseConfig(config)), sha, only };
  return runChecks(testEngine([commonPack]), plan);
}

describe('common/duplication', () => {
  it('runs jscpd over the code, leaving tests and generated files out', async () => {
    const result = await run(
      {
        'src/a.ts': TOTAL,
        'src/b.ts': `export const x = 1;\n\n${TOTAL}`,
        'src/a.test.ts': TOTAL,
        'eslint.config.js': `${generatedHeader('//', '1.0.0')}${TOTAL}`,
      },
      ['common/duplication'],
    );
    const outcome = result.outcomes[0];
    expect(outcome?.status).toBe('findings');
    expect(outcome?.findings.map((f) => [f.rule, f.location])).toEqual([
      ['jscpd/clone', { file: 'src/b.ts', line: 3, endLine: 13 }],
    ]);
  });

  it('skips a repository with no code', async () => {
    const result = await run({ 'README.md': '# x\n' }, ['common/duplication']);
    expect(result.outcomes[0]).toMatchObject({ status: 'skipped' });
  });
});

describe('common/suppressions', () => {
  it('reports every suppression in the project, none in generated files', async () => {
    const result = await run(
      {
        'src/a.ts': '// eslint-disable-next-line no-console\nconsole.log(1);\n',
        'app.py': 'import os  # noqa: F401\n',
        'eslint.config.js': `${generatedHeader('//', '1.0.0')}// eslint-disable\n`,
      },
      ['common/suppressions'],
    );
    expect(result.outcomes[0]?.findings.map((f) => [f.rule, f.location?.file])).toEqual([
      ['suppression/eslint-disable', 'src/a.ts'],
      ['suppression/noqa', 'app.py'],
    ]);
  });
});

describe('custom checks', () => {
  const config = [
    MINIMAL_CONFIG,
    'checks:',
    '  links:',
    `    run: "printf '%s\\\\n' '{\\"rule\\": \\"dead\\", \\"file\\": \\"README.md\\", \\"line\\": 1, \\"message\\": \\"A dead link.\\"}'; exit 1"`,
    '    scope: head',
    '  quick: { run: "true", scope: commit }',
    '  broken: { run: "echo not json", scope: commit }',
    '',
  ].join('\n');

  it('reads the findings a head-tier check prints, whatever its exit code', async () => {
    const result = await run({ 'README.md': '# x\n' }, ['common/custom-head'], config);
    expect(result.outcomes[0]?.findings).toMatchObject([
      {
        rule: 'custom/links/dead',
        message: 'A dead link.',
        location: { file: 'README.md', line: 1 },
      },
    ]);
  });

  it('is an engine error naming the check that printed something else', async () => {
    const result = await run({ 'README.md': '# x\n' }, ['common/custom-commit'], config);
    expect(result.outcomes[0]).toMatchObject({ status: 'error' });
    expect(result.outcomes[0]?.reason).toMatch(/^custom check broken: output line 1 is not JSON/);
  });

  it('skips when talos.yml declares none for the tier', async () => {
    const result = await run({ 'README.md': '# x\n' }, ['common/custom-head']);
    expect(result.outcomes[0]).toMatchObject({ status: 'skipped' });
  });
});
