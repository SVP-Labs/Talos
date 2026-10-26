import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Io } from './io.js';
import { currentOs } from './run.js';
import { assess, selfTest } from './self-test.js';
import type { Outcome, RunResult } from '../core/result.js';

/** A project whose README says a word its glossary avoids. */
const PROJECT = {
  'talos.yml': 'name: Notes\nprefix: NO\n',
  'README.md': '# Notes\n\nEach memo is a page of text.\n',
  'docs/glossary.md': '# Glossary\n\n**Note**\nOne dated page of text.\nAvoid: memo\n',
};

const HERE = currentOs();
const ELSEWHERE = HERE === 'macos' ? 'linux' : 'macos';

/**
 * Test projects in a directory, each expecting what it's given, on this OS unless it says, and
 * with its own `talos.yml` where `configs` gives one.
 */
async function cases(
  expectations: Readonly<Record<string, object>>,
  configs: Readonly<Record<string, string>> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'talos-self-test-'));
  for (const [name, expectation] of Object.entries(expectations)) {
    const files = {
      ...PROJECT,
      ...(configs[name] === undefined ? {} : { 'talos.yml': configs[name] }),
      'expect.json': JSON.stringify({ os: [HERE], ...expectation }),
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, name, path)), { recursive: true });
      await writeFile(join(root, name, path), content);
    }
  }
  return root;
}

function ioAt(cwd: string): Io & { text: () => string } {
  const out: string[] = [];
  return { cwd, env: {}, out: (t) => out.push(t), err: () => undefined, text: () => out.join('') };
}

describe('talos self-test', () => {
  it('runs each case and compares its findings with what the case expects', async () => {
    const root = await cases(
      {
        found: { checks: ['docs/glossary'], rules: ['glossary/avoid'] },
        missing: { checks: ['docs/glossary'], rules: ['glossary/nothing'] },
        dirty: { checks: ['docs/glossary'], clean: true },
        elsewhere: { checks: ['docs/glossary'], os: [ELSEWHERE] },
      },
      { elsewhere: `${PROJECT['talos.yml']}components:\n  - { lang: py, os: [${ELSEWHERE}] }\n` },
    );
    const io = ioAt(root);
    expect(await selfTest([root], io)).toBe(1);
    expect(io.text()).toBe(
      [
        'FAIL dirty',
        '     expected no findings, got glossary/avoid',
        'ok   found',
        'FAIL missing',
        '     no glossary/nothing finding',
        '2 case(s) failed',
        '',
      ].join('\n'),
    );
  });

  it('fails a case that expects an OS its talos.yml runs no component on, wherever it runs', async () => {
    const root = await cases({
      unplanned: { checks: ['docs/glossary'], os: ['linux', 'windows', 'macos'] },
    });
    const io = ioAt(root);
    expect(await selfTest([root], io)).toBe(1);
    expect(io.text()).toBe(
      [
        'FAIL unplanned',
        '     expect.json lists windows, macos, which no component in talos.yml runs on',
        '1 case(s) failed',
        '',
      ].join('\n'),
    );
  });

  it('runs only the cases --only names, and passes when they do', async () => {
    const root = await cases({
      'docs-found': { checks: ['docs/glossary'], rules: ['glossary/avoid'] },
      'other-missing': { checks: ['docs/glossary'], rules: ['glossary/nothing'] },
    });
    const io = ioAt(root);
    expect(await selfTest(['--only', 'docs', root], io)).toBe(0);
    expect(io.text()).toBe('ok   docs-found\nall cases passed\n');
  });
});

describe('assess', () => {
  function outcome(check: string, extra: Partial<Outcome> = {}): Outcome {
    return { check, tier: 'head', status: 'passed', durationMs: 1, findings: [], ...extra };
  }
  const result = (outcomes: readonly Outcome[]): RunResult => ({
    talos: '0.0.0',
    sha: '0'.repeat(40),
    tiers: ['commit', 'head'],
    os: 'linux',
    outcomes,
  });

  it('names engine errors and expected checks that skipped, with why', () => {
    const problems = assess(
      { checks: ['py/types', 'py/lint', 'py/arch'], rules: [], clean: false, os: ['linux'] },
      result([
        outcome('py/types', { status: 'error', reason: 'basedpyright crashed' }),
        outcome('py/lint', { status: 'skipped', reason: 'no Python files' }),
      ]),
    );
    expect(problems).toEqual([
      'engine error in py/types: basedpyright crashed',
      'py/lint did not run: no Python files',
      'py/arch did not run',
    ]);
  });

  it('finds nothing wrong with a case that ran clean as expected', () => {
    const expected = { checks: ['ts/lint'], rules: [], clean: true, os: ['linux' as const] };
    expect(assess(expected, result([outcome('ts/lint')]))).toEqual([]);
  });
});
