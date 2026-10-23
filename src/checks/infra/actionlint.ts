import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { z } from 'zod';
import { parseJson, sentence, toolFailed } from './report.js';
import { EngineError } from '../../core/check.js';
import type { CheckContext } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

const PROJECT_CONFIGS = ['.github/actionlint.yaml', '.github/actionlint.yml'];

const projectConfig = z.object({
  'self-hosted-runner': z.object({ labels: z.array(z.string()).nullish() }).nullish(),
  'config-variables': z.array(z.string()).nullish(),
});

function readYaml(text: string): unknown {
  try {
    const value: unknown = parseYaml(text);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * The config the gate gives actionlint: of the project's own, only the self-hosted runners'
 * labels and the configuration variables it declares. Its `paths` section, which can ignore
 * errors, is left out.
 */
export function actionlintConfig(projectText: string | undefined): string {
  const parsed = projectConfig.safeParse(
    projectText === undefined ? {} : (readYaml(projectText) ?? {}),
  );
  const kept: Record<string, unknown> = {};
  const labels = parsed.data?.['self-hosted-runner']?.labels;
  const variables = parsed.data?.['config-variables'];
  if (labels !== undefined && labels !== null) kept['self-hosted-runner'] = { labels };
  if (variables !== undefined && variables !== null) kept['config-variables'] = variables;
  return stringify(kept);
}

const error = z.object({
  message: z.string(),
  filepath: z.string(),
  line: z.number().int(),
  column: z.number().int(),
  kind: z.string(),
});

const SHELLCHECK = /SC(\d+):\w+:\d+:\d+: (.+)$/;

function toFinding(e: z.infer<typeof error>): Finding {
  const location = { file: e.filepath, line: e.line, column: e.column };
  const sc = e.kind === 'shellcheck' ? SHELLCHECK.exec(e.message) : null;
  if (sc?.[1] !== undefined && sc[2] !== undefined) {
    return {
      rule: 'actionlint/shellcheck',
      message: `SC${sc[1]}: ${sentence(sc[2])}`,
      location,
      docs: `https://www.shellcheck.net/wiki/SC${sc[1]}`,
    };
  }
  return {
    rule: `actionlint/${e.kind}`,
    message: sentence(e.message),
    location,
    docs: 'https://github.com/rhysd/actionlint/blob/main/docs/checks.md',
  };
}

/** actionlint's `{{json .}}` output as findings. */
export function parseActionlint(stdout: string): Finding[] {
  const parsed = z.array(error).safeParse(parseJson(stdout, 'actionlint'));
  if (!parsed.success) throw new EngineError('actionlint printed JSON Talos cannot read');
  return parsed.data.map(toFinding);
}

async function projectText(root: string): Promise<string | undefined> {
  for (const path of PROJECT_CONFIGS) {
    const text = await readFile(join(root, path), 'utf8').catch(() => undefined);
    if (text !== undefined) return text;
  }
  return undefined;
}

/** actionlint over the workflows, with shellcheck from `tools.lock` for their `run:` scripts. */
export async function actionlint(
  ctx: CheckContext,
  workflows: readonly string[],
): Promise<Finding[]> {
  if (workflows.length === 0) return [];
  const [tool, shellcheck] = await Promise.all([
    ctx.tools.path('actionlint'),
    ctx.tools.path('shellcheck'),
  ]);
  const config = join(ctx.scratch, 'actionlint.yaml');
  await writeFile(config, actionlintConfig(await projectText(ctx.root)));
  const args = ['-format', '{{json .}}', '-no-color', '-config-file', config];
  const tools = [`-shellcheck=${shellcheck}`, '-pyflakes='];
  const result = await ctx.exec(tool, [...args, ...tools, '--', ...workflows], { cwd: ctx.root });
  if (result.code > 1) throw toolFailed('actionlint', result);
  return parseActionlint(result.stdout);
}
