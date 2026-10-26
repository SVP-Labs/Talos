import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { batches, dockerfiles } from './files.js';
import { parseJson, sentence, toolFailed } from './report.js';
import { EngineError } from '../../core/check.js';
import type { CheckContext } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

/** Everything hadolint reports down to `info` is a finding; `style` and `ignore` are not. */
const COUNTED = new Set(['error', 'warning', 'info']);

/** hadolint's settings, which the generated `.hadolint.yaml` and the gate share. */
export function hadolintSettings(): string {
  return 'failure-threshold: info\n';
}

const result = z.object({
  code: z.string(),
  file: z.string(),
  line: z.number().int(),
  column: z.number().int(),
  level: z.string(),
  message: z.string(),
});

function docsFor(code: string): string {
  return code.startsWith('SC')
    ? `https://www.shellcheck.net/wiki/${code}`
    : `https://github.com/hadolint/hadolint/wiki/${code}`;
}

/** hadolint's JSON output as findings. */
export function parseHadolint(stdout: string): Finding[] {
  const parsed = z.array(result).safeParse(parseJson(stdout, 'hadolint'));
  if (!parsed.success) throw new EngineError('hadolint printed JSON Talos cannot read');
  return parsed.data
    .filter((r) => COUNTED.has(r.level))
    .map((r) => ({
      rule: `hadolint/${r.code}`,
      message: sentence(r.message),
      location: { file: r.file, line: r.line, column: r.column },
      docs: docsFor(r.code),
    }));
}

/**
 * hadolint over every Dockerfile and Containerfile, with the settings Talos writes into its
 * scratch directory: the repository's `.hadolint.yaml` plays no part in the gate.
 */
export async function dockerfile(ctx: CheckContext): Promise<Finding[]> {
  const files = dockerfiles(ctx.facts.files);
  if (files.length === 0) return [];
  const hadolint = await ctx.tools.path('hadolint');
  const config = join(ctx.scratch, 'hadolint.yaml');
  await writeFile(config, hadolintSettings());
  const args = [
    '--config',
    config,
    '--format',
    'json',
    '--failure-threshold',
    'info',
    '--no-color',
  ];
  const findings: Finding[] = [];
  for (const batch of batches(files)) {
    const run = await ctx.exec(hadolint, [...args, '--', ...batch], { cwd: ctx.root });
    if (run.code > 1) throw toolFailed('hadolint', run);
    findings.push(...parseHadolint(run.stdout));
  }
  return findings;
}
