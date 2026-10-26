import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { actionlint, actionlintConfig, parseActionlint } from './actionlint.js';
import { infraPack } from './index.js';
import { infraContext, ok, recording } from './test/context.js';
import { parseZizmor, ZIZMOR_CONFIG, zizmor } from './zizmor.js';
import { EngineError } from '../../core/check.js';

/** actionlint 1.7.12, `-format '{{json .}}'`, snippets trimmed. */
const ACTIONLINT = JSON.stringify([
  {
    message:
      '"github.event.pull_request.title" is potentially untrusted. avoid using it directly in inline scripts. instead, pass it through an environment variable. see https://docs.github.com/en/actions/reference/security/secure-use#good-practices-for-mitigating-script-injection-attacks for more details',
    filepath: '.github/workflows/ci.yml',
    line: 9,
    column: 23,
    kind: 'expression',
    snippet: '',
    end_column: 53,
  },
  {
    message:
      'shellcheck reported issue in this script: SC2086:info:1:6: Double quote to prevent globbing and word splitting',
    filepath: '.github/workflows/ci.yml',
    line: 10,
    column: 9,
    kind: 'shellcheck',
    snippet: '',
    end_column: 12,
  },
  {
    message: "could not parse as YAML: did not find expected ',' or ']'",
    filepath: '.github/workflows/broken.yml',
    line: 3,
    column: 13,
    kind: 'syntax-check',
    snippet: '  a:',
    end_column: 13,
  },
]);

/** zizmor 1.31.1, `--persona pedantic --format json`, routes and features trimmed. */
const ZIZMOR = JSON.stringify([
  {
    ident: 'unpinned-uses',
    desc: 'unpinned action reference',
    url: 'https://docs.zizmor.sh/audits/#unpinned-uses',
    determinations: { confidence: 'High', severity: 'High', persona: 'Regular' },
    locations: [
      {
        symbolic: {
          key: { Local: { verbatim_path: '.github/actions/setup/action.yml' } },
          annotation: 'this step',
          feature_kind: 'Normal',
          kind: 'Hidden',
        },
        concrete: {
          location: {
            start_point: { row: 5, column: 6 },
            end_point: { row: 5, column: 33 },
            offset_span: { start: 80, end: 107 },
          },
          comments: [],
        },
      },
      {
        symbolic: {
          key: { Local: { verbatim_path: '.github/actions/setup/action.yml' } },
          annotation: 'action is not pinned to a hash (required by blanket policy)',
          feature_kind: { Subfeature: { after: 0, fragment: { Raw: 'actions/setup-node@v4' } } },
          kind: 'Primary',
        },
        concrete: {
          location: {
            start_point: { row: 5, column: 12 },
            end_point: { row: 5, column: 33 },
            offset_span: { start: 86, end: 107 },
          },
          comments: [],
        },
      },
    ],
    ignored: false,
  },
  {
    ident: 'excessive-permissions',
    desc: 'overly broad permissions',
    url: 'https://docs.zizmor.sh/audits/#excessive-permissions',
    determinations: { confidence: 'Medium', severity: 'Medium', persona: 'Regular' },
    locations: [
      {
        symbolic: {
          key: { Local: { verbatim_path: '.github/workflows/ci.yml' } },
          annotation: 'default permissions used due to no permissions: block',
          feature_kind: 'Normal',
          kind: 'Primary',
        },
        concrete: {
          location: {
            start_point: { row: 0, column: 0 },
            end_point: { row: 16, column: 0 },
            offset_span: { start: 0, end: 332 },
          },
          comments: [],
        },
      },
    ],
    ignored: false,
  },
]);

describe('parseActionlint', () => {
  it('reports each error under its kind, one sentence each', () => {
    const findings = parseActionlint(ACTIONLINT);
    expect(findings[0]).toEqual({
      rule: 'actionlint/expression',
      message: '"github.event.pull_request.title" is potentially untrusted.',
      location: { file: '.github/workflows/ci.yml', line: 9, column: 23 },
      docs: 'https://github.com/rhysd/actionlint/blob/main/docs/checks.md',
    });
    expect(findings[1]).toMatchObject({
      rule: 'actionlint/shellcheck',
      message: 'SC2086: Double quote to prevent globbing and word splitting.',
      docs: 'https://www.shellcheck.net/wiki/SC2086',
    });
    expect(findings[2]?.rule).toBe('actionlint/syntax-check');
  });

  it('reads an empty list as clean, and anything else as an engine error', () => {
    expect(parseActionlint('[]\n')).toEqual([]);
    expect(() => parseActionlint('could not read "x.yml"')).toThrow(EngineError);
    expect(() => parseActionlint('')).toThrow(EngineError);
  });
});

describe('actionlintConfig', () => {
  it("keeps the project's runner labels and variables, and drops what ignores errors", () => {
    const project = [
      'self-hosted-runner:',
      '  labels: [gpu-runner]',
      'config-variables: [DEPLOY_ENV]',
      'paths:',
      '  .github/workflows/**/*.yml:',
      '    ignore: [".*"]',
    ].join('\n');
    expect(actionlintConfig(project)).toBe(
      'self-hosted-runner:\n  labels:\n    - gpu-runner\nconfig-variables:\n  - DEPLOY_ENV\n',
    );
  });

  it('gives an empty config without a usable project file', () => {
    expect(actionlintConfig(undefined)).toBe('{}\n');
    expect(actionlintConfig('paths: [')).toBe('{}\n');
    expect(actionlintConfig('self-hosted-runner: 3')).toBe('{}\n');
  });
});

describe('parseZizmor', () => {
  it('reports each finding at its primary location, rows made 1-based', () => {
    const findings = parseZizmor(ZIZMOR);
    expect(findings[0]).toEqual({
      rule: 'zizmor/unpinned-uses',
      message:
        'Unpinned action reference: action is not pinned to a hash (required by blanket policy).',
      location: { file: '.github/actions/setup/action.yml', line: 6, column: 13 },
      docs: 'https://docs.zizmor.sh/audits/#unpinned-uses',
    });
    expect(findings[1]?.location).toEqual({
      file: '.github/workflows/ci.yml',
      line: 1,
      column: 1,
      endLine: 16,
    });
  });

  it('leaves out ignored findings, and refuses output it cannot read', () => {
    const ignored = JSON.stringify(
      (JSON.parse(ZIZMOR) as unknown[]).map((f) => ({ ...(f as object), ignored: true })),
    );
    expect(parseZizmor(ignored)).toEqual([]);
    expect(parseZizmor('[]')).toEqual([]);
    expect(() => parseZizmor('fatal: no audit was performed')).toThrow(EngineError);
  });
});

describe('infra/workflows', () => {
  const workflows = infraPack.checks.find((c) => c.id === 'infra/workflows');

  it('runs actionlint over workflows and zizmor over workflows, actions and Dependabot', async () => {
    const { exec, calls } = recording((call) =>
      call.command.endsWith('actionlint') ? ok(ACTIONLINT, 1) : ok(ZIZMOR),
    );
    const ctx = await infraContext(
      {
        '.github/workflows/ci.yml': 'on: push\n',
        '.github/actions/setup/action.yml': 'name: setup\n',
        '.github/dependabot.yml': 'version: 2\n',
        '.github/actionlint.yaml': 'paths:\n  "**": { ignore: [".*"] }\n',
      },
      exec,
    );
    const findings = await workflows?.run(ctx);
    expect(findings?.map((f) => f.rule)).toEqual([
      'actionlint/expression',
      'actionlint/shellcheck',
      'actionlint/syntax-check',
      'zizmor/unpinned-uses',
      'zizmor/excessive-permissions',
    ]);
    const lint = calls[0]?.args ?? [];
    const audit = calls[1]?.args ?? [];
    expect(lint).toContain('-shellcheck=/tools/shellcheck');
    expect(lint.slice(-2)).toEqual(['--', '.github/workflows/ci.yml']);
    expect(await readFile(lint[lint.indexOf('-config-file') + 1] ?? '', 'utf8')).toBe('{}\n');
    expect(audit).toEqual(expect.arrayContaining(['--persona', 'pedantic', '--offline']));
    expect(audit.slice(-4)).toEqual([
      '--',
      '.github/workflows/ci.yml',
      '.github/actions/setup/action.yml',
      '.github/dependabot.yml',
    ]);
    expect(await readFile(audit[audit.indexOf('--config') + 1] ?? '', 'utf8')).toBe(ZIZMOR_CONFIG);
  });

  it('skips actionlint without workflows, and fails on any zizmor exit but 0', async () => {
    const { exec, calls } = recording(() => ({ code: 1, stdout: '', stderr: 'fatal: no audit' }));
    const ctx = await infraContext({ 'action.yml': 'name: a\n' }, exec);
    expect(await actionlint(ctx, [])).toEqual([]);
    await expect(zizmor(ctx, ['action.yml'])).rejects.toThrow('zizmor exited 1:\nfatal: no audit');
    expect(calls).toHaveLength(1);
  });
});

describe('the infra pack', () => {
  it('applies each check only where there is something for it', async () => {
    const ctx = await infraContext({ 'src/app.ts': '' }, recording(() => ok('')).exec);
    for (const check of infraPack.checks) {
      expect(check.applies(ctx).applies).toBe(false);
    }
    const busy = await infraContext(
      {
        'run.sh': '',
        Dockerfile: '',
        'setup.ps1': '',
        '.github/workflows/ci.yml': '',
      },
      recording(() => ok('')).exec,
    );
    for (const check of infraPack.checks) {
      expect(check.applies(busy).applies).toBe(true);
    }
  });
});
