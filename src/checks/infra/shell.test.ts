import { describe, expect, it } from 'vitest';
import { parseShellcheck, shell } from './shell.js';
import { infraContext, ok, recording } from './test/context.js';
import { EngineError } from '../../core/check.js';

/** shellcheck 0.11.0, `--format=json1 --enable=all --exclude=SC2250`, fixes trimmed. */
const RECORDED = JSON.stringify({
  comments: [
    {
      file: 'scripts/hook',
      line: 2,
      endLine: 2,
      column: 1,
      endColumn: 9,
      level: 'warning',
      code: 2164,
      message: "Use 'cd ... || exit' or 'cd ... || return' in case cd fails.",
      fix: null,
    },
    {
      file: 'scripts/deploy.sh',
      line: 4,
      endLine: 4,
      column: 10,
      endColumn: 25,
      level: 'error',
      code: 2045,
      message: 'Iterating over ls output is fragile. Use globs.',
      fix: null,
    },
    {
      file: 'scripts/deploy.sh',
      line: 5,
      endLine: 5,
      column: 8,
      endColumn: 10,
      level: 'info',
      code: 2086,
      message: 'Double quote to prevent globbing and word splitting.',
      fix: null,
    },
  ],
});

describe('parseShellcheck', () => {
  it('reports each comment under its SC code, with its span', () => {
    const findings = parseShellcheck(RECORDED);
    expect(findings.map((f) => f.rule)).toEqual([
      'shellcheck/SC2164',
      'shellcheck/SC2045',
      'shellcheck/SC2086',
    ]);
    expect(findings[1]).toEqual({
      rule: 'shellcheck/SC2045',
      message: 'Iterating over ls output is fragile.',
      location: { file: 'scripts/deploy.sh', line: 4, endLine: 4, column: 10 },
      docs: 'https://www.shellcheck.net/wiki/SC2045',
    });
    expect(findings[2]?.location).toMatchObject({ line: 5, endLine: 5, column: 8 });
  });

  it('reads a clean run as no findings, and anything else as an engine error', () => {
    expect(parseShellcheck('{"comments":[]}')).toEqual([]);
    expect(() => parseShellcheck('missing.sh: openBinaryFile: does not exist')).toThrow(
      EngineError,
    );
    expect(() => parseShellcheck('{"comments":[{"file":1}]}')).toThrow(EngineError);
  });
});

describe('shell', () => {
  it('runs shellcheck with every setting on the command line, over every script', async () => {
    const { exec, calls } = recording(() => ok(RECORDED, 1));
    const ctx = await infraContext(
      {
        'scripts/deploy.sh': 'ls\n',
        'scripts/hook': '#!/bin/sh\ncd $HOME\n',
        'bin/cli': '#!/usr/bin/env node\n',
      },
      exec,
    );
    const findings = await shell(ctx);
    expect(findings).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/tools/shellcheck');
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['--norc', '--format=json1', '--enable=all', '--exclude=SC2250']),
    );
    expect(calls[0]?.args.slice(-3)).toEqual(['--', 'scripts/deploy.sh', 'scripts/hook']);
  });

  it('fetches nothing when no file turns out to be a shell script', async () => {
    const { exec, calls } = recording(() => ok(''));
    const ctx = await infraContext({ 'bin/cli': '#!/usr/bin/env node\n' }, exec);
    expect(await shell(ctx)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('turns a shellcheck failure into an engine error', async () => {
    const { exec } = recording(() => ({ code: 2, stdout: '', stderr: 'a.sh: does not exist' }));
    const ctx = await infraContext({ 'a.sh': 'echo\n' }, exec);
    await expect(shell(ctx)).rejects.toThrow('shellcheck exited 2:\na.sh: does not exist');
  });
});
