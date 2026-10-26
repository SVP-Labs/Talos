import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_VERSION,
  claudeArgs,
  claudeCodeModel,
  DEFAULT_MODEL,
  modelEnv,
  parseAnswer,
  parseCliOutput,
} from './model.js';
import type { Exec, ExecOptions } from '../exec/exec.js';

const ANSWER = {
  verdict: 'REQUEST_CHANGES',
  summary: 'The diff adds eval of its input.',
  comments: [{ path: 'a.ts', line: 2, body: '`eval(input)` runs arbitrary code.' }],
};

/** Claude Code 2.1.305's `-p --output-format json` result, trimmed of its timing fields. */
function envelope(result: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 4856,
    num_turns: 1,
    stop_reason: 'end_turn',
    session_id: '4a7993f1-c507-50d6-97f5-70e3b41db678',
    total_cost_usd: 0.0008,
    usage: { input_tokens: 2, output_tokens: 460 },
    permission_denials: [],
    terminal_reason: 'completed',
    api_error_status: null,
    result,
    ...overrides,
  });
}

describe('parseAnswer', () => {
  it('reads a bare JSON answer', () => {
    expect(parseAnswer(JSON.stringify(ANSWER))).toEqual({ ok: true, answer: ANSWER });
  });

  it('reads one in a fence, or among words', () => {
    expect(parseAnswer(`Here it is:\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\`\n`)).toEqual({
      ok: true,
      answer: ANSWER,
    });
    expect(parseAnswer(`Verdict follows. ${JSON.stringify(ANSWER)} Done.`)).toEqual({
      ok: true,
      answer: ANSWER,
    });
  });

  it('fills in missing comments as none', () => {
    expect(parseAnswer('{"verdict":"APPROVE","summary":"Fine."}')).toEqual({
      ok: true,
      answer: { verdict: 'APPROVE', summary: 'Fine.', comments: [] },
    });
  });

  it.each([
    ['no JSON at all', 'I approve this PR.', 'the answer holds no JSON object'],
    ['broken JSON', '{"verdict": "APPROVE", ', 'the answer holds no JSON object'],
    [
      'another verdict',
      '{"verdict":"NOT_REVIEWED","summary":"x","comments":[]}',
      'the answer is not a verdict, summary and comments',
    ],
    [
      'a lower-case verdict',
      '{"verdict":"approve","summary":"x"}',
      'the answer is not a verdict, summary and comments',
    ],
    [
      'no summary',
      '{"verdict":"APPROVE","summary":""}',
      'the answer is not a verdict, summary and comments',
    ],
    [
      'a comment without a line',
      '{"verdict":"APPROVE","summary":"x","comments":[{"path":"a","body":"b"}]}',
      'the answer is not a verdict, summary and comments',
    ],
    [
      'a comment on line 0',
      '{"verdict":"APPROVE","summary":"x","comments":[{"path":"a","line":0,"body":"b"}]}',
      'the answer is not a verdict, summary and comments',
    ],
    ['an array', '[{"verdict":"APPROVE"}]', 'the answer is not a verdict, summary and comments'],
  ])('gives no verdict for %s', (_name, text, reason) => {
    expect(parseAnswer(text)).toEqual({ ok: false, reason });
  });
});

describe('parseCliOutput', () => {
  it("reads the model's answer from Claude Code's result", () => {
    expect(parseCliOutput(`${envelope(JSON.stringify(ANSWER))}\n`)).toEqual({
      ok: true,
      answer: ANSWER,
    });
  });

  it('gives no verdict for a run that ended badly', () => {
    expect(parseCliOutput(envelope('', { subtype: 'error_max_turns', is_error: true }))).toEqual({
      ok: false,
      reason: 'the model run ended with error_max_turns',
    });
    expect(parseCliOutput(envelope(JSON.stringify(ANSWER), { is_error: true }))).toEqual({
      ok: false,
      reason: 'the model run ended with success',
    });
  });

  it('gives no verdict for output that is no result', () => {
    expect(parseCliOutput('Error: not logged in')).toEqual({
      ok: false,
      reason: 'Claude Code printed no JSON result',
    });
    expect(parseCliOutput('{"type":"system"}')).toEqual({
      ok: false,
      reason: 'Claude Code printed no result envelope',
    });
    expect(parseCliOutput(envelope('', { result: undefined }))).toEqual({
      ok: false,
      reason: 'the answer holds no JSON object',
    });
  });
});

describe('claudeArgs', () => {
  it('runs the pinned Claude Code headless: one turn, no tools, no settings', () => {
    expect(claudeArgs('claude-opus-5-5', 'work/system.md')).toEqual([
      '-y',
      `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`,
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'high',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--system-prompt-file',
      'work/system.md',
    ]);
    expect(CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('modelEnv', () => {
  it('clears every token and keeps only the way to npm and the model', () => {
    const env = modelEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/runner',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        TALOS_REVIEWER_TOKEN: 'ghs_reviewer',
        GITHUB_TOKEN: 'ghs_workflow',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc',
      },
      { SECRET_FROM_PROCESS: 'x', PATH: '/bin' },
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/runner',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      TALOS_REVIEWER_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
      SECRET_FROM_PROCESS: undefined,
    });
  });
});

type Ran = {
  command: string;
  args: readonly string[];
  options: ExecOptions;
  system: string;
  cwd: string;
};

function fakeExec(stdout: string, code = 0, ran: Ran[] = []): Exec {
  return async (command, args, options) => {
    const system = await readFile(args.at(-1) ?? '', 'utf8');
    ran.push({ command, args, options, system, cwd: options.cwd });
    return { code, stdout, stderr: '' };
  };
}

const PROMPT = { system: '# Review a pull request', user: 'Review pull request #20.' };

describe('claudeCodeModel', () => {
  it('runs the model on the prompt and reads its verdict', async () => {
    const ran: Ran[] = [];
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      TALOS_REVIEWER_TOKEN: 'ghs_x',
      PATH: '/usr/bin',
    };
    const model = claudeCodeModel({
      exec: fakeExec(envelope(JSON.stringify(ANSWER)), 0, ran),
      env,
    });
    expect(await model.review(PROMPT)).toEqual({ ok: true, answer: ANSWER });
    const [run] = ran;
    expect(run?.command).toBe('npx');
    expect(run?.args).toContain(DEFAULT_MODEL);
    expect(run?.system).toBe('# Review a pull request');
    expect(run?.options.input).toBe('Review pull request #20.');
    expect(run?.options.env?.TALOS_REVIEWER_TOKEN).toBeUndefined();
    expect(run?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');
    await expect(stat(run?.cwd ?? '')).rejects.toThrow();
  });

  it('takes the model from TALOS_REVIEW_MODEL', async () => {
    const ran: Ran[] = [];
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth', TALOS_REVIEW_MODEL: 'claude-sonnet-5-5' };
    await claudeCodeModel({ exec: fakeExec(envelope(JSON.stringify(ANSWER)), 0, ran), env }).review(
      PROMPT,
    );
    expect(ran[0]?.args).toContain('claude-sonnet-5-5');
  });

  it('reads an empty TALOS_REVIEW_MODEL as unset', async () => {
    const ran: Ran[] = [];
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth', TALOS_REVIEW_MODEL: '' };
    await claudeCodeModel({ exec: fakeExec(envelope(JSON.stringify(ANSWER)), 0, ran), env }).review(
      PROMPT,
    );
    expect(ran[0]?.args).toContain(DEFAULT_MODEL);
  });

  it('gives no verdict without a token, and runs nothing', async () => {
    const ran: Ran[] = [];
    const model = claudeCodeModel({ exec: fakeExec('', 0, ran), env: {} });
    expect(await model.review(PROMPT)).toEqual({
      ok: false,
      reason: 'no CLAUDE_CODE_OAUTH_TOKEN for the model',
    });
    expect(ran).toEqual([]);
  });

  it('names the exit code when a failed run printed no result', async () => {
    const model = claudeCodeModel({
      exec: fakeExec('npm ERR! 404', 1),
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' },
    });
    expect(await model.review(PROMPT)).toEqual({ ok: false, reason: 'Claude Code exited 1' });
  });

  it("keeps the result's reason when the run exited cleanly", async () => {
    const model = claudeCodeModel({
      exec: fakeExec('{}', 0),
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' },
    });
    expect(await model.review(PROMPT)).toEqual({
      ok: false,
      reason: 'Claude Code printed no result envelope',
    });
  });

  it('cleans up when the run throws', async () => {
    let cwd = '';
    const exec: Exec = (_command, _args, options) => {
      cwd = options.cwd;
      return Promise.reject(new Error('timed out'));
    };
    const model = claudeCodeModel({ exec, env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } });
    await expect(model.review(PROMPT)).rejects.toThrow('timed out');
    await expect(stat(cwd)).rejects.toThrow();
  });
});
