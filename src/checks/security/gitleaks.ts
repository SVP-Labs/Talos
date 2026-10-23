import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { probeConfig } from './gitleaks-config.js';
import { type CheckContext, EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

/**
 * gitleaks' report, through its Go template: never the secret, only its SHA-256 (sprig's
 * `sha256sum`), so the report on disk holds nothing to leak. `--redact` would hash the word
 * REDACTED instead, so the scan runs without it.
 */
export const REPORT_TEMPLATE =
  '[{{ range $i, $f := . }}{{ if $i }},{{ end }}' +
  '{"rule":{{ $f.RuleID | toJson }},"file":{{ $f.File | toJson }},' +
  '"line":{{ $f.StartLine }},"commit":{{ $f.Commit | toJson }},' +
  '"secret":{{ $f.Secret | sha256sum | toJson }}}{{ end }}]\n';

const report = z.array(
  z.object({
    rule: z.string(),
    file: z.string(),
    line: z.number(),
    commit: z.string(),
    secret: z.string().regex(/^[0-9a-f]{64}$/),
  }),
);

/**
 * One finding per secret gitleaks found anywhere in the history. A secret in an old commit
 * points at no line of the checkout, so its key is the rule and a hash of the secret: the same
 * secret committed again counts again, and its commit and line never change its identity.
 */
export function parseGitleaksReport(text: string): Finding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EngineError("gitleaks' report is not JSON");
  }
  const parsed = report.safeParse(raw);
  if (!parsed.success) throw new EngineError("gitleaks' report is not in the expected form");
  return parsed.data.map((leak) => ({
    rule: `gitleaks/${leak.rule}`,
    key: `${leak.rule} ${leak.secret.slice(0, 16)}`,
    message:
      `A secret (${leak.rule}) was committed to ${leak.file} at line ${leak.line} in ` +
      `${leak.commit.slice(0, 8)}; revoke it, then remove it.`,
  }));
}

const COLOUR = new RegExp(`${String.fromCodePoint(27)}\\[[\\d;]*m`, 'g');

/** The last line gitleaks logged, without its terminal colours. */
function lastLine(text: string): string {
  const lines = text.replaceAll(COLOUR, '').trim().split('\n');
  return lines.findLast((line) => line.trim() !== '') ?? '';
}

/** Scans every commit reachable from the checked-out one; `--all` would reach other branches. */
export async function scanHistory(
  ctx: CheckContext,
  tool: string,
  config: string,
): Promise<Finding[]> {
  const template = join(ctx.scratch, 'report.tmpl');
  const output = join(ctx.scratch, 'gitleaks.json');
  await writeFile(template, REPORT_TEMPLATE);
  const args = [
    'git',
    '--no-banner',
    '--log-level=error',
    '--exit-code=0',
    `--config=${config}`,
    '--report-format=template',
    `--report-template=${template}`,
    `--report-path=${output}`,
    `--log-opts=--full-history --diff-filter=tuxdb ${ctx.sha}`,
    '.',
  ];
  const result = await ctx.exec(tool, args, { cwd: ctx.root });
  if (result.code !== 0) {
    throw new EngineError(`gitleaks exited ${result.code}: ${lastLine(result.stderr)}`);
  }
  return parseGitleaksReport(await readFile(output, 'utf8'));
}

/** Which of `ids` name one of gitleaks' default rules, asked of gitleaks itself. */
export async function defaultRuleIds(
  ctx: CheckContext,
  tool: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  return ctx.memo(`security/gitleaks-defaults/${JSON.stringify(ids)}`, async () => {
    const empty = join(ctx.scratch, 'probe-target');
    await mkdir(empty, { recursive: true });
    const known = await Promise.all(
      ids.map(async (id, index) => {
        const config = join(ctx.scratch, `probe-${index}.toml`);
        await writeFile(config, probeConfig(id));
        const args = ['dir', '--no-banner', '--log-level=fatal', '--exit-code=0'];
        const result = await ctx.exec(tool, [...args, `--config=${config}`, empty], {
          cwd: ctx.scratch,
        });
        return result.code === 0 ? [id] : [];
      }),
    );
    return new Set(known.flat());
  });
}
