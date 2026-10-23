import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { dockerfile, parseHadolint } from './dockerfile.js';
import { infraContext, ok, recording } from './test/context.js';
import { EngineError } from '../../core/check.js';

/** hadolint 2.15.1, `--format json --failure-threshold info`, over three Dockerfiles. */
const RECORDED = JSON.stringify([
  {
    code: 'DL3007',
    column: 1,
    file: 'Dockerfile',
    level: 'warning',
    line: 1,
    message:
      'Using latest is prone to errors if the image will ever update. Pin the version explicitly to a release tag',
  },
  {
    code: 'DL3009',
    column: 1,
    file: 'Dockerfile',
    level: 'info',
    line: 2,
    message: 'Delete the apt lists (/var/lib/apt/lists) after installing something',
  },
  {
    code: 'DL3000',
    column: 1,
    file: 'Dockerfile',
    level: 'error',
    line: 3,
    message: 'Use absolute WORKDIR',
  },
  {
    code: 'DL3048',
    column: 1,
    file: 'Style.dockerfile',
    level: 'style',
    line: 2,
    message: 'Invalid label key.',
  },
  {
    code: 'SC2086',
    column: 1,
    file: 'Style.dockerfile',
    level: 'info',
    line: 3,
    message: 'Double quote to prevent globbing and word splitting.',
  },
  {
    code: 'DL1000',
    column: 1,
    file: 'Bad.dockerfile',
    level: 'error',
    line: 3,
    message: "unexpected 'N'\nexpecting '#', '\\', ADD, ARG, CMD, COPY, ENTRYPOINT",
  },
]);

describe('parseHadolint', () => {
  it('reports everything down to info, each under its code', () => {
    const findings = parseHadolint(RECORDED);
    expect(findings.map((f) => f.rule)).toEqual([
      'hadolint/DL3007',
      'hadolint/DL3009',
      'hadolint/DL3000',
      'hadolint/SC2086',
      'hadolint/DL1000',
    ]);
    expect(findings[0]).toEqual({
      rule: 'hadolint/DL3007',
      message: 'Using latest is prone to errors if the image will ever update.',
      location: { file: 'Dockerfile', line: 1, column: 1 },
      docs: 'https://github.com/hadolint/hadolint/wiki/DL3007',
    });
    expect(findings[3]?.docs).toBe('https://www.shellcheck.net/wiki/SC2086');
    expect(findings[4]?.message).toBe("Unexpected 'N'.");
  });

  it('reads an empty list as clean, and no JSON as an engine error', () => {
    expect(parseHadolint('[]')).toEqual([]);
    expect(() => parseHadolint('')).toThrow(EngineError);
    expect(() => parseHadolint('[{"code":3}]')).toThrow(EngineError);
  });
});

describe('dockerfile', () => {
  it("runs hadolint with Talos's settings, never the repository's", async () => {
    const { exec, calls } = recording(() => ok(RECORDED, 1));
    const ctx = await infraContext(
      { Dockerfile: 'FROM ubuntu:latest\n', '.hadolint.yaml': 'ignored: [DL3007]\n' },
      exec,
    );
    const findings = await dockerfile(ctx);
    expect(findings).toHaveLength(5);
    const args = calls[0]?.args ?? [];
    const config = args[args.indexOf('--config') + 1] ?? '';
    expect(config.startsWith(ctx.scratch)).toBe(true);
    expect(await readFile(config, 'utf8')).toBe('failure-threshold: info\n');
    expect(args.slice(-2)).toEqual(['--', 'Dockerfile']);
  });

  it('turns a run that printed no JSON into an engine error', async () => {
    const { exec } = recording(() => ({
      code: 1,
      stdout: '',
      stderr: 'withBinaryFile: does not exist',
    }));
    const ctx = await infraContext({ Dockerfile: 'FROM x\n' }, exec);
    await expect(dockerfile(ctx)).rejects.toThrow(/hadolint printed no readable JSON/);
  });
});
