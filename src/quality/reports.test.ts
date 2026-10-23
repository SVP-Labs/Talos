import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CoverageFormat } from './protocol.js';
import { readCoverage, readReport, readTests } from './reports.js';
import { junitXml, testContext } from './test/context.js';
import { EngineError } from '../core/check.js';

describe('readReport', () => {
  it('reads a report, and calls a missing one an engine error', async () => {
    const ctx = await testContext();
    const path = join(ctx.scratch, 'r.txt');
    await writeFile(path, 'é');
    expect(await readReport(path, 'test report')).toBe('é');
    expect(await readReport(path, 'test report', 'latin1')).toBe('Ã©');
    await expect(readReport(join(ctx.scratch, 'none'), 'JUnit report')).rejects.toThrow(
      new EngineError(`could not read the JUnit report ${join(ctx.scratch, 'none')}`),
    );
  });
});

describe('readTests', () => {
  it('makes each test’s file repository-relative and identifies it by that file', async () => {
    const ctx = await testContext({ component: { lang: 'ts', root: 'web', os: ['linux'] } });
    const junit = join(ctx.scratch, 'j.xml');
    await writeFile(
      junit,
      junitXml([
        { name: 'a', file: 'src/a.test.ts', status: 'failed', message: 'nope' },
        { name: 'b', file: '/elsewhere/b.test.ts' },
        { name: 'c' },
      ]),
    );
    expect(await readTests(ctx, [{ path: junit, base: join(ctx.root, 'web') }])).toEqual([
      {
        id: 'web/src/a.test.ts::a',
        name: 'a',
        status: 'failed',
        file: 'web/src/a.test.ts',
        message: 'nope',
      },
      { id: 'b', name: 'b', status: 'passed' },
      { id: 'c', name: 'c', status: 'passed' },
    ]);
  });

  it('keeps a test’s line', async () => {
    const ctx = await testContext();
    const junit = join(ctx.scratch, 'j.xml');
    await writeFile(
      junit,
      '<testsuite><testcase name="t" classname="spec.a_spec_lua:7"/></testsuite>',
    );
    expect(await readTests(ctx, [{ path: junit, base: ctx.root }])).toEqual([
      { id: 'spec.a_spec_lua::t', name: 't', status: 'passed', line: 7 },
    ]);
  });
});

async function coverageOf(
  files: Record<string, string>,
  format: CoverageFormat,
  report: string,
  options: { yml?: string; root?: string } = {},
) {
  const ctx = await testContext({
    files,
    tracked: ['untracked-not.ts'],
    ...(options.yml === undefined ? {} : { yml: options.yml }),
    ...(options.root === undefined
      ? {}
      : { component: { lang: 'ts', root: options.root, os: ['linux'] } }),
  });
  const path = join(ctx.scratch, 'report');
  await writeFile(path, report.replaceAll('$ROOT', ctx.root));
  const coverage = await readCoverage(ctx, { path, base: ctx.root, format });
  return Object.fromEntries(
    [...coverage].map(([file, lines]) => [file, [[...lines.executable], [...lines.covered]]]),
  );
}

describe('readCoverage', () => {
  it('reads LCOV, keeping only tracked files of the component outside exclude', async () => {
    const lcov = [
      'SF:web/src/a.ts',
      'DA:1,1',
      'DA:2,0',
      'end_of_record',
      'SF:web/gen/b.ts',
      'DA:1,0',
      'end_of_record',
      'SF:api/c.ts',
      'DA:1,0',
      'end_of_record',
      'SF:web/src/untracked.ts',
      'DA:1,0',
      'end_of_record',
      'SF:/elsewhere/d.ts',
      'DA:1,0',
      'end_of_record',
      '',
    ].join('\n');
    const files = { 'web/src/a.ts': '', 'web/gen/b.ts': '', 'api/c.ts': '' };
    const yml = 'name: T\nprefix: T\nexclude: [web/gen]\n';
    expect(await coverageOf(files, 'lcov', lcov, { yml, root: 'web' })).toEqual({
      'web/src/a.ts': [[1, 2], [1]],
    });
  });

  it('reads Cobertura relative to a source directory, or absolute', async () => {
    const xml = `<coverage><sources><source>$ROOT/pkg</source></sources><packages><package><classes>
<class filename="calc.py"><lines><line number="1" hits="1"/></lines></class>
<class filename="$ROOT/tool.py"><lines><line number="2" hits="0"/></lines></class>
</classes></package></packages></coverage>`;
    expect(await coverageOf({ 'pkg/calc.py': '', 'tool.py': '' }, 'cobertura', xml)).toEqual({
      'pkg/calc.py': [[1], [1]],
      'tool.py': [[2], []],
    });
  });

  it('reads Clover', async () => {
    const xml =
      '<coverage><project><file name="$ROOT/src/A.php"><line num="3" type="stmt" count="2"/></file></project></coverage>';
    expect(await coverageOf({ 'src/A.php': '' }, 'clover', xml)).toEqual({
      'src/A.php': [[3], [3]],
    });
  });

  it('reads luacov’s statistics against the sources, as luacov’s reporter counts lines', async () => {
    const files = { 'src/a.lua': 'local t = {}\n\nfunction t.f()\n  return 1\nend\nreturn t\n' };
    const stats = '6:./src/a.lua\n1 0 1 0 0 1 \n2:/usr/share/lua/x.lua\n1 1 \n';
    expect(await coverageOf(files, 'luacov', stats)).toEqual({
      'src/a.lua': [
        [1, 3, 4, 6],
        [1, 3, 6],
      ],
    });
  });

  it('calls a tracked luacov source it cannot read an engine error', async () => {
    const ctx = await testContext({ tracked: ['src/gone.lua'] });
    const path = join(ctx.scratch, 'stats');
    await writeFile(path, '1:src/gone.lua\n1 \n');
    await expect(readCoverage(ctx, { path, base: ctx.root, format: 'luacov' })).rejects.toThrow(
      'could not read the luacov source',
    );
  });
});
