import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { pyprojectTool } from './configs.js';
import { fromTool, pythonFiles } from './paths.js';
import { sentence } from './ruff.js';
import { type Bound, failed, runTool } from './run.js';
import { componentDir } from '../../core/component.js';
import type { Finding } from '../../core/finding.js';

/** vulture's own codes, which its `# noqa` comments name. */
const CODES: Readonly<Record<string, string>> = {
  attribute: 'V101',
  class: 'V102',
  function: 'V103',
  import: 'V104',
  method: 'V105',
  property: 'V106',
  variable: 'V107',
};

const UNREACHABLE = 'V201';

export type DeadCode = {
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  readonly code: string;
  readonly message: string;
};

const LINE = /^(.+?):(\d+): (.+) \(\d+% confidence(?:, (\d+) lines?)?\)$/;
const UNUSED = /^unused (\w+) '(.+)'$/;

function describe(text: string): { code: string; message: string } {
  const unused = UNUSED.exec(text);
  const kind = unused?.[1];
  const code = kind === undefined ? undefined : CODES[kind];
  if (unused !== null && kind !== undefined && code !== undefined) {
    return { code, message: `The ${kind} '${unused[2] ?? ''}' is never used.` };
  }
  return { code: UNREACHABLE, message: sentence(text.charAt(0).toUpperCase() + text.slice(1)) };
}

/** Reads vulture's report, one line per item, run with `--sort-by-size` so each gives its span. */
export function parseVulture(text: string): DeadCode[] {
  return text.split(/\r?\n/).flatMap((raw) => {
    const match = LINE.exec(raw.trim());
    if (match === null) return [];
    const [, file = '', at = '1', what = '', size = '1'] = match;
    const line = Number(at);
    return [{ file, line, endLine: line + Math.max(1, Number(size)) - 1, ...describe(what) }];
  });
}

const settings = z.object({
  ignore_names: z.array(z.string()).optional(),
  ignore_decorators: z.array(z.string()).optional(),
});

/**
 * Names used only dynamically are declared in `[tool.vulture]` as `ignore_names` and
 * `ignore_decorators`; nothing else from the project's vulture settings applies, so it can't
 * raise the confidence threshold or exclude paths.
 */
async function declared(ctx: Bound): Promise<string[]> {
  const parsed = settings.safeParse((await pyprojectTool(componentDir(ctx))).vulture ?? {});
  if (!parsed.success) return [];
  const { ignore_names: names = [], ignore_decorators: decorators = [] } = parsed.data;
  return [
    ...(names.length > 0 ? ['--ignore-names', names.join(',')] : []),
    ...(decorators.length > 0 ? ['--ignore-decorators', decorators.join(',')] : []),
  ];
}

export async function deadCode(ctx: Bound): Promise<Finding[]> {
  const files = pythonFiles(ctx).filter((file) => file.endsWith('.py'));
  if (files.length === 0) return [];
  const config = join(ctx.scratch, 'vulture.toml');
  await writeFile(config, '');
  const args = ['--min-confidence', '0', '--sort-by-size', '--config', config];
  const result = await runTool(ctx, 'vulture', [...args, ...(await declared(ctx)), ...files]);
  if (![0, 1, 3].includes(result.code)) throw failed('vulture', result);
  return parseVulture(result.stdout).map((d) => ({
    rule: `vulture/${d.code}`,
    message: d.message,
    location: { file: fromTool(ctx, d.file), line: d.line, endLine: d.endLine },
  }));
}
