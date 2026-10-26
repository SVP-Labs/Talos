import { z } from 'zod';
import { batches, shellScripts } from './files.js';
import { parseJson, sentence, toolFailed } from './report.js';
import { EngineError } from '../../core/check.js';
import type { CheckContext } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

/** Every optional check but braces around every variable, which the scripts' style leaves out. */
export const SHELLCHECK_ENABLE = 'all';
export const SHELLCHECK_DISABLE = 'SC2250';

/**
 * The gate passes every setting itself and reads no `.shellcheckrc`, so only a directive in
 * a script, which counts as a suppression, can turn a rule off.
 */
const SHELLCHECK_ARGS = [
  '--norc',
  '--format=json1',
  `--enable=${SHELLCHECK_ENABLE}`,
  `--exclude=${SHELLCHECK_DISABLE}`,
  '--severity=style',
  '--external-sources',
  '--source-path=SCRIPTDIR',
];

const comment = z.object({
  file: z.string(),
  line: z.number().int(),
  endLine: z.number().int(),
  column: z.number().int(),
  code: z.number().int(),
  message: z.string(),
});

const output = z.object({ comments: z.array(comment) });

/** shellcheck's `json1` output as findings. */
export function parseShellcheck(stdout: string): Finding[] {
  const parsed = output.safeParse(parseJson(stdout, 'shellcheck'));
  if (!parsed.success) throw new EngineError('shellcheck printed JSON Talos cannot read');
  return parsed.data.comments.map((c) => ({
    rule: `shellcheck/SC${c.code}`,
    message: sentence(c.message),
    location: {
      file: c.file,
      line: c.line,
      endLine: Math.max(c.line, c.endLine),
      column: c.column,
    },
    docs: `https://www.shellcheck.net/wiki/SC${c.code}`,
  }));
}

/** shellcheck over every shell script: named `.sh` or `.bash`, or with a shell's shebang. */
export async function shell(ctx: CheckContext): Promise<Finding[]> {
  const scripts = await shellScripts(ctx.root, ctx.facts.files);
  if (scripts.length === 0) return [];
  const shellcheck = await ctx.tools.path('shellcheck');
  const findings: Finding[] = [];
  for (const batch of batches(scripts)) {
    const result = await ctx.exec(shellcheck, [...SHELLCHECK_ARGS, '--', ...batch], {
      cwd: ctx.root,
    });
    if (result.code > 1) throw toolFailed('shellcheck', result);
    findings.push(...parseShellcheck(result.stdout));
  }
  return findings;
}
