import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mutationChecks, mutationTargets } from './mutation.js';
import type { MutationFormat, MutationRunner } from './protocol.js';
import { testContext } from './test/context.js';
import type { Check, Component, Lang } from '../core/check.js';
import type { ChangeSet, FileChange } from '../repo/changes.js';

const YML = 'name: T\nprefix: T\nmutation: [src/risk, src/gate.ts]\n';

function change(path: string, fields: Partial<FileChange> = {}): FileChange {
  return {
    path,
    status: 'modified',
    added: [{ start: 1, end: 1 }],
    removed: [],
    addedText: [],
    removedText: [],
    ...fields,
  };
}

function changes(...files: FileChange[]): ChangeSet {
  return { files: new Map(files.map((file) => [file.path, file])) };
}

function check(lang: Lang, runner: MutationRunner): Check {
  const [only] = mutationChecks(lang, runner);
  if (only === undefined) throw new Error('one check expected');
  return only;
}

const idle: MutationRunner = {
  run: () => Promise.reject(new Error('not run')),
};

const TRACKED = [
  'src/risk/score.ts',
  'src/risk/score.test.ts',
  'src/risk/types.d.ts',
  'src/risk/__tests__/helper.ts',
  'src/gate.ts',
  'src/other.ts',
];

describe('mutationChecks', () => {
  it('gives a language one head-tier mutation check', () => {
    const only = check('ts', idle);
    expect([only.id, only.tier, only.scope, only.langs]).toEqual([
      'ts/mutation',
      'head',
      'component',
      ['ts'],
    ]);
  });

  it('applies only when talos.yml declares mutation paths', async () => {
    const ctx = await testContext({ tracked: TRACKED });
    expect(check('ts', idle).applies(ctx)).toEqual({
      applies: false,
      reason: 'talos.yml declares no mutation paths',
    });
  });

  it('applies alone when source of the component lies under the paths', async () => {
    expect(check('ts', idle).applies(await testContext({ tracked: TRACKED, yml: YML }))).toEqual({
      applies: true,
    });
    expect(check('py', idle).applies(await testContext({ tracked: TRACKED, yml: YML }))).toEqual({
      applies: false,
      reason: 'no source file of the component is under the mutation paths',
    });
  });

  it('applies in a comparison only when the change touches a file under the paths', async () => {
    const touching = await testContext({
      tracked: TRACKED,
      yml: YML,
      side: 'head',
      changes: changes(change('src/gate.ts')),
    });
    expect(check('ts', idle).applies(touching)).toEqual({ applies: true });
    const renamedAway = await testContext({
      tracked: TRACKED,
      yml: YML,
      side: 'base',
      changes: changes(change('lib/gate.ts', { status: 'renamed', oldPath: 'src/gate.ts' })),
    });
    expect(check('ts', idle).applies(renamedAway)).toEqual({ applies: true });
    const elsewhere = await testContext({
      tracked: TRACKED,
      yml: YML,
      side: 'head',
      changes: changes(change('src/other.ts'), change('src/risk/score.test.ts')),
    });
    expect(check('ts', idle).applies(elsewhere)).toEqual({
      applies: false,
      reason: 'the change touches no file under the mutation paths',
    });
    const nothingCompared = await testContext({ tracked: TRACKED, yml: YML, side: 'head' });
    expect(check('ts', idle).applies(nothingCompared)).toEqual({
      applies: false,
      reason: 'nothing is compared',
    });
  });
});

describe('mutationTargets', () => {
  it('takes every source file under the paths when nothing is compared', async () => {
    const ctx = await testContext({ tracked: TRACKED, yml: YML });
    expect(mutationTargets('ts', ctx)).toEqual(['src/risk/score.ts', 'src/gate.ts']);
  });

  it('keeps to the component', async () => {
    const component: Component = { lang: 'ts', root: 'src/risk', os: ['linux'] };
    const ctx = await testContext({ tracked: TRACKED, yml: YML, component });
    expect(mutationTargets('ts', ctx)).toEqual(['src/risk/score.ts']);
  });

  it('takes the touched files by their name on each side of the change', async () => {
    const edit = changes(
      change('src/risk/score.ts', { status: 'renamed', oldPath: 'src/risk/old.ts' }),
      change('src/gate.ts', { status: 'added' }),
      change('src/risk/gone.ts', { status: 'deleted' }),
    );
    const head = await testContext({ tracked: TRACKED, yml: YML, side: 'head', changes: edit });
    expect(mutationTargets('ts', head)).toEqual(['src/gate.ts', 'src/risk/score.ts']);
    const base = await testContext({
      tracked: ['src/risk/old.ts', 'src/risk/gone.ts'],
      yml: YML,
      side: 'base',
      changes: edit,
    });
    expect(mutationTargets('ts', base)).toEqual(['src/risk/gone.ts', 'src/risk/old.ts']);
    const nothingCompared = await testContext({ tracked: TRACKED, yml: YML, side: 'head' });
    expect(mutationTargets('ts', nothingCompared)).toEqual([]);
  });
});

/** A runner that writes `report` into scratch, relative to `base`, and remembers its files. */
function writing(format: MutationFormat, report: string, base: string) {
  const asked: (readonly string[])[] = [];
  const runner: MutationRunner = {
    run: async (ctx, files) => {
      asked.push(files);
      const path = join(ctx.scratch, 'mutants.json');
      await writeFile(path, report);
      return { path, base: join(ctx.root, base), format };
    },
  };
  return { runner, asked };
}

const STRYKER = JSON.stringify({
  schemaVersion: '1.0',
  files: {
    'src/risk/score.ts': {
      source: 'export const score = (n: number) => n > 0;\n',
      mutants: [
        {
          mutatorName: 'EqualityOperator',
          replacement: 'n >= 0',
          status: 'Survived',
          location: { start: { line: 1, column: 37 }, end: { line: 1, column: 42 } },
        },
        {
          mutatorName: 'BooleanLiteral',
          replacement: 'true',
          status: 'Killed',
          location: { start: { line: 1, column: 37 }, end: { line: 1, column: 42 } },
        },
      ],
    },
    'src/other.ts': {
      source: 'x\n',
      mutants: [
        {
          mutatorName: 'StringLiteral',
          status: 'Survived',
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        },
      ],
    },
    '../../elsewhere/x.ts': {
      source: 'x\n',
      mutants: [
        {
          mutatorName: 'StringLiteral',
          status: 'NoCoverage',
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        },
      ],
    },
  },
});

describe('the mutation check', () => {
  it('mutates the targets and reports their surviving mutants', async () => {
    const ctx = await testContext({
      files: { 'src/risk/score.ts': 'export const score = (n: number) => n > 0;\n' },
      tracked: ['src/other.ts'],
      yml: YML,
    });
    const { runner, asked } = writing('stryker', STRYKER, '.');
    const findings = await check('ts', runner).run(ctx);
    expect(asked).toEqual([['src/risk/score.ts']]);
    expect(findings).toEqual([
      {
        rule: 'mutation/survived',
        message: 'No test fails when `n > 0` becomes `n >= 0` (EqualityOperator).',
        location: { file: 'src/risk/score.ts', line: 1 },
        key: 'EqualityOperator: n > 0 → n >= 0',
      },
    ]);
  });

  it('runs nothing when no target is left at this checkout', async () => {
    const ctx = await testContext({
      tracked: ['src/other.ts'],
      yml: YML,
      side: 'head',
      changes: changes(change('src/gate.ts', { status: 'deleted' })),
    });
    expect(await check('ts', idle).run(ctx)).toEqual([]);
  });

  it('reads cargo-mutants’ original code from the mutated sources', async () => {
    const source = 'pub fn quiet(h: u8) -> bool {\n    h < 7\n}\n';
    const ctx = await testContext({
      files: { 'core/src/risk/q.rs': source },
      yml: 'name: T\nprefix: T\nmutation: [core/src/risk]\n',
    });
    const outcomes = JSON.stringify({
      outcomes: [
        {
          scenario: {
            Mutant: {
              name: 'src/risk/q.rs:2:7: replace < with == in quiet',
              file: 'src/risk/q.rs',
              span: { start: { line: 2, column: 7 }, end: { line: 2, column: 8 } },
              replacement: '==',
              genre: 'BinaryOperator',
            },
          },
          summary: 'MissedMutant',
        },
        {
          scenario: {
            Mutant: {
              name: '../elsewhere.rs:1:1: replace f with g',
              file: '../../elsewhere.rs',
              replacement: 'g',
              genre: 'FnValue',
            },
          },
          summary: 'MissedMutant',
        },
      ],
    });
    const { runner } = writing('cargo-mutants', outcomes, 'core');
    const findings = await check('rust', runner).run(ctx);
    expect(findings.map((finding) => [finding.location?.file, finding.key])).toEqual([
      ['core/src/risk/q.rs', 'BinaryOperator: < → =='],
    ]);
  });

  it('reads Infection’s and mutmut’s reports', async () => {
    const infection = JSON.stringify({
      stats: {},
      escaped: [
        {
          mutator: {
            mutatorName: 'Plus',
            originalFilePath: 'src/risk/Score.php',
            originalStartLine: 3,
          },
          diff: '@@ @@\n-return $a + $b;\n+return $a - $b;\n',
        },
      ],
    });
    const php = await testContext({ files: { 'src/risk/Score.php': '' }, yml: YML });
    const fromInfection = await check('php', writing('infection', infection, '.').runner).run(php);
    expect(fromInfection.map((finding) => finding.key)).toEqual([
      'Plus: return $a + $b; → return $a - $b;',
    ]);

    const mutmut = JSON.stringify({
      format: 'talos-mutmut/1',
      mutants: [
        {
          name: 'risk.score.x_f__mutmut_1',
          file: 'src/risk/score.py',
          status: 'survived',
          functionLine: 1,
          diff: '@@ -1,2 +1,2 @@\n def f(a):\n-    return a + 1\n+    return a - 1\n',
        },
      ],
    });
    const py = await testContext({ files: { 'src/risk/score.py': '' }, yml: YML });
    const fromMutmut = await check('py', writing('mutmut', mutmut, '.').runner).run(py);
    expect(fromMutmut.map((finding) => [finding.location?.line, finding.message])).toEqual([
      [2, 'No test fails when `return a + 1` becomes `return a - 1` (risk.score.x_f__mutmut_1).'],
    ]);
  });

  it('calls a report it cannot read an engine error', async () => {
    const ctx = await testContext({ files: { 'src/gate.ts': '' }, yml: YML });
    await expect(check('ts', writing('stryker', 'nope', '.').runner).run(ctx)).rejects.toThrow(
      'the Stryker report is not JSON',
    );
  });
});
