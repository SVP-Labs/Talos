import { describe, expect, it } from 'vitest';
import { applyExceptions, entryLines, type ExceptionInputs, workflowSteps } from './exceptions.js';
import { workflows } from './index.js';
import { infraContext, ok, recording } from './test/context.js';
import { parseZizmorResults, type ZizmorResult } from './zizmor.js';
import { parseConfig } from '../../config/load.js';
import type { WorkflowException } from '../../config/schema.js';
import { tempRepo } from '../../testing/engine.js';

const NOW = new Date('2026-10-29T12:00:00Z');
const FILE = '.github/workflows/central.yml';

const ENTRY: WorkflowException = {
  rule: 'zizmor/github-app',
  file: FILE,
  job: 'privacy',
  step: 'properties',
  reason: 'the listing needs Metadata read across the installation',
  expires: '2027-04-29',
};

/** A workflow whose `privacy` job mints its token in the step `properties`, at `index`. */
function workflow(index: number): string {
  const before = Array.from({ length: index }, (_, n) => `      - run: echo ${String(n)}\n`);
  return [
    'on: push\n',
    'jobs:\n',
    '  privacy:\n',
    '    runs-on: ubuntu-latest\n',
    '    steps:\n',
    ...before,
    '      - id: properties\n',
    '        uses: actions/create-github-app-token@0000000000000000000000000000000000000000\n',
    '      - name: Mint by name\n',
    '        uses: actions/create-github-app-token@0000000000000000000000000000000000000000\n',
  ].join('');
}

/** A `github-app` finding in `job`'s step at `index` of `file`. */
function appToken(index: number, job = 'privacy', file = FILE): ZizmorResult {
  return {
    finding: {
      rule: 'zizmor/github-app',
      message: 'Dangerous use of GitHub App tokens.',
      location: { file, line: 10 + index },
    },
    step: { job, index },
  };
}

const CONFIG = [
  'name: Test',
  'prefix: T',
  'exceptions:',
  '  workflows:',
  `    - rule: zizmor/github-app`,
  `      file: ${FILE}`,
  '      job: privacy',
  '      step: properties',
  '      reason: the listing needs Metadata read across the installation',
  '      expires: 2027-04-29',
  '',
].join('\n');

async function inputs(
  entries: readonly WorkflowException[],
  files: Readonly<Record<string, string>> = { [FILE]: workflow(1) },
): Promise<ExceptionInputs> {
  return { entries, now: NOW, stepName: workflowSteps(await tempRepo(files)), configText: CONFIG };
}

const rules = (found: readonly { rule: string }[]): string[] => found.map((f) => f.rule);

describe('applyExceptions', () => {
  it('leaves out a finding an entry matches on rule, file, job and step, and nothing else', async () => {
    expect(await applyExceptions([appToken(1)], await inputs([ENTRY]))).toEqual([]);
  });

  it('keeps the finding, and calls the entry unused, when any of the four differs', async () => {
    const others: WorkflowException[] = [
      { ...ENTRY, rule: 'zizmor/excessive-permissions' },
      { ...ENTRY, file: '.github/workflows/other.yml' },
      { ...ENTRY, job: 'channels' },
      { ...ENTRY, step: 'token' },
    ];
    for (const entry of others) {
      const found = await applyExceptions([appToken(1)], await inputs([entry]));
      expect(rules(found), JSON.stringify(entry)).toEqual([
        'zizmor/github-app',
        'infra/exception-unused',
      ]);
    }
  });

  it('follows a step that moved, and knows a step by its name when it has no id', async () => {
    const moved = await inputs([ENTRY], { [FILE]: workflow(3) });
    expect(await applyExceptions([appToken(3)], moved)).toEqual([]);
    const byName = { ...ENTRY, step: 'Mint by name' };
    expect(await applyExceptions([appToken(2)], await inputs([byName]))).toEqual([]);
  });

  it('never excepts a finding outside a step, or in a step it cannot read', async () => {
    const { finding } = appToken(1);
    const found = await applyExceptions(
      [{ finding }, appToken(1, 'privacy', '.github/workflows/gone.yml'), appToken(9)],
      await inputs([ENTRY]),
    );
    expect(rules(found)).toEqual([
      'zizmor/github-app',
      'zizmor/github-app',
      'zizmor/github-app',
      'infra/exception-unused',
    ]);
  });

  it('lets an expired entry except nothing, and fails every change with it, at its line', async () => {
    const found = await applyExceptions(
      [appToken(1)],
      await inputs([{ ...ENTRY, expires: '2026-10-29' }]),
    );
    expect(found).toEqual([
      appToken(1).finding,
      expect.objectContaining({
        rule: 'infra/exception-expired',
        policy: 'always',
        location: { file: 'talos.yml', line: 5 },
      }),
    ]);
  });

  it('calls an entry that runs more than a year too long, and still lets it except', async () => {
    const found = await applyExceptions(
      [appToken(1)],
      await inputs([{ ...ENTRY, expires: '2027-12-01' }]),
    );
    expect(found).toEqual([
      expect.objectContaining({
        rule: 'infra/exception-too-long',
        key: 'zizmor/github-app .github/workflows/central.yml privacy properties',
      }),
    ]);
  });
});

describe('entryLines', () => {
  it("finds each entry's line, block or flow, and nothing without the key", () => {
    expect(entryLines(CONFIG)).toEqual([5]);
    const flow = 'exceptions:\n  workflows:\n    - { rule: a }\n    - { rule: b }\n';
    expect(entryLines(flow)).toEqual([3, 4]);
    expect(entryLines('name: X\n')).toEqual([]);
    expect(entryLines('exceptions: 3\n')).toEqual([]);
  });
});

describe('exceptions.workflows in talos.yml', () => {
  it('reads every field, and defaults to none', () => {
    expect(parseConfig(CONFIG).exceptions.workflows).toEqual([ENTRY]);
    expect(parseConfig('name: X\nprefix: X\n').exceptions).toEqual({ workflows: [] });
  });

  it('refuses another tool, a missing reason, a bad or impossible date and any other field', () => {
    const bad = [
      CONFIG.replace('zizmor/github-app', 'actionlint/expression'),
      CONFIG.replace('      reason: the listing needs Metadata read across the installation\n', ''),
      CONFIG.replace('2027-04-29', 'soon'),
      CONFIG.replace('2027-04-29', '2027-13-01'),
      CONFIG.replace('2027-04-29', '2027-02-30'),
      CONFIG.replace('      job: privacy\n', '      job: privacy\n      line: 61\n'),
    ];
    for (const text of bad) expect(() => parseConfig(text), text).toThrow();
  });
});

/** zizmor 1.31.1's `github-app` finding, as it reports one, trimmed to what Talos reads. */
const GITHUB_APP = JSON.stringify([
  {
    ident: 'github-app',
    desc: 'dangerous use of GitHub App tokens',
    url: 'https://docs.zizmor.sh/audits/#github-app',
    locations: [
      {
        symbolic: {
          key: { Local: { verbatim_path: FILE } },
          annotation: 'token granted access to all repositories for this owner',
          route: {
            route: [{ Key: 'jobs' }, { Key: 'privacy' }, { Key: 'steps' }, { Index: 1 }],
          },
          kind: 'Primary',
        },
        concrete: {
          location: { start_point: { row: 7, column: 8 }, end_point: { row: 8, column: 0 } },
        },
      },
    ],
  },
]);

describe('parseZizmorResults', () => {
  it("reads the job and step from the finding's route, and no step from anything else", () => {
    const [result] = parseZizmorResults(GITHUB_APP);
    expect(result?.step).toEqual({ job: 'privacy', index: 1 });
    const elsewhere = GITHUB_APP.replace('{"Key":"steps"},{"Index":1}', '{"Key":"permissions"}');
    expect(parseZizmorResults(elsewhere)[0]?.step).toBeUndefined();
    const unknown = GITHUB_APP.replace('{"Index":1}', '{"Other":1}');
    expect(parseZizmorResults(unknown)[0]?.step).toBeUndefined();
  });
});

describe('infra/workflows with exceptions', () => {
  it("leaves out the finding talos.yml excepts, and runs without a workflow for the entry's sake", async () => {
    const { exec } = recording((call) =>
      call.command.endsWith('actionlint') ? ok('[]') : ok(GITHUB_APP),
    );
    const ctx = await infraContext({ [FILE]: workflow(1), 'talos.yml': CONFIG }, exec);
    expect(await workflows({ ...ctx, config: parseConfig(CONFIG) }, NOW)).toEqual([]);
    expect(rules(await workflows(ctx, NOW))).toEqual(['zizmor/github-app']);
    const bare = await infraContext({ 'talos.yml': CONFIG }, exec);
    expect(await workflows({ ...bare, config: parseConfig(CONFIG) }, NOW)).toEqual([
      expect.objectContaining({ rule: 'infra/exception-unused' }),
    ]);
  });
});
