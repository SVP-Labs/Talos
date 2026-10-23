import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Prompt } from './prompt.js';
import type { Exec } from '../exec/exec.js';

/**
 * The model behind the reviewer's AI review, behind a small interface so tests use a fake. The
 * real one is Claude Code, headless: one turn, no tools, no settings, no MCP servers, run in an
 * empty folder with an environment that holds nothing but what it needs to reach the model.
 */

/** Claude Code's exact version: npm releases at least a day old, as every Talos install. */
export const CLAUDE_CODE_VERSION = '2.1.305';
export const DEFAULT_MODEL = 'claude-opus-5-5';
const TIMEOUT_MS = 15 * 60 * 1000;
const REASON_MAX = 200;

const commentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  body: z.string().min(1),
});

const answerSchema = z.object({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES']),
  summary: z.string().min(1),
  comments: z.array(commentSchema).max(100).default([]),
});

type Answer = z.infer<typeof answerSchema>;

export type ModelResult =
  { readonly ok: true; readonly answer: Answer } | { readonly ok: false; readonly reason: string };

export type ReviewModel = { review(prompt: Prompt): Promise<ModelResult> };

function failed(reason: string): ModelResult {
  return {
    ok: false,
    reason: reason.length <= REASON_MAX ? reason : `${reason.slice(0, REASON_MAX - 1)}…`,
  };
}

/** The text inside the first fenced block, when there is one. */
function fencedBlock(text: string): string | undefined {
  const open = text.indexOf('```');
  if (open === -1) return undefined;
  const start = text.indexOf('\n', open);
  const close = start === -1 ? -1 : text.indexOf('```', start);
  return close === -1 ? undefined : text.slice(start + 1, close);
}

/** The JSON object in the model's text: all of it, a fenced block, or the outermost braces. */
function jsonIn(text: string): unknown {
  const trimmed = text.trim();
  const fenced = fencedBlock(trimmed);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const candidates = [trimmed, fenced, start === -1 ? undefined : trimmed.slice(start, end + 1)];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // The next candidate may hold it.
    }
  }
  return undefined;
}

/** The model's answer, validated; anything else is no verdict, and never an approval. */
export function parseAnswer(text: string): ModelResult {
  const json = jsonIn(text);
  if (json === undefined) return failed('the answer holds no JSON object');
  const parsed = answerSchema.safeParse(json);
  if (!parsed.success) return failed('the answer is not a verdict, summary and comments');
  return { ok: true, answer: parsed.data };
}

const resultSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
});

/** Claude Code's `--output-format json` line: a result envelope around the model's text. */
export function parseCliOutput(stdout: string): ModelResult {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim());
  } catch {
    return failed('Claude Code printed no JSON result');
  }
  const envelope = resultSchema.safeParse(json);
  if (!envelope.success) return failed('Claude Code printed no result envelope');
  const { subtype, is_error: isError, result } = envelope.data;
  if (isError || subtype !== 'success') return failed(`the model run ended with ${subtype}`);
  return parseAnswer(result ?? '');
}

export function claudeArgs(model: string, systemFile: string): string[] {
  return [
    '-y',
    `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`,
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
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
    systemFile,
  ];
}

/** What the model run may see of the job's environment: the way to npm and to the model. */
const PASSED: ReadonlySet<string> = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'ComSpec',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'npm_config_cache',
  'npm_config_registry',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The environment for the model run: every variable the job or this process holds is cleared
 * unless it is on the list, so no GitHub token ever reaches it.
 */
export function modelEnv(
  env: Env,
  inherited: Env = process.env,
): Record<string, string | undefined> {
  const names = new Set([...Object.keys(inherited), ...Object.keys(env)]);
  return Object.fromEntries(
    [...names].map((name) => [name, PASSED.has(name) ? env[name] : undefined]),
  );
}

export type ClaudeCodeOptions = {
  readonly exec: Exec;
  readonly env: Env;
  readonly timeoutMs?: number;
};

/** The reviewer's model: Claude Code, headless, with `TALOS_REVIEW_MODEL` or Opus. */
export function claudeCodeModel(options: ClaudeCodeOptions): ReviewModel {
  return {
    review: async (prompt) => {
      const token = options.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (token === undefined || token === '') {
        return failed('no CLAUDE_CODE_OAUTH_TOKEN for the model');
      }
      const model = options.env.TALOS_REVIEW_MODEL ?? DEFAULT_MODEL;
      const dir = await mkdtemp(join(options.env.RUNNER_TEMP ?? tmpdir(), 'talos-review-'));
      try {
        const systemFile = join(dir, 'system.md');
        await writeFile(systemFile, prompt.system, 'utf8');
        const run = await options.exec('npx', claudeArgs(model, systemFile), {
          cwd: dir,
          env: modelEnv(options.env),
          input: prompt.user,
          timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
        });
        const result = parseCliOutput(run.stdout);
        return result.ok || run.code === 0 ? result : failed(`Claude Code exited ${run.code}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
