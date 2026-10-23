import { ruffConfigFile } from './configs.js';
import { fromTool, pythonFiles } from './paths.js';
import { parseRuffJson } from './ruff.js';
import { type Bound, failed, runTool } from './run.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

function lines(from: number, to: number): string {
  return from === to ? `Line ${from} is` : `Lines ${from} to ${to} are`;
}

/**
 * `ruff format --check`: one finding per file, spanning its first to its last unformatted line.
 * A file ruff can't parse is left to py/lint, which reports the syntax error.
 */
export async function format(ctx: Bound): Promise<Finding[]> {
  const files = pythonFiles(ctx);
  if (files.length === 0) {
    throw new EngineError('py/format ran on a component with no Python files');
  }
  const config = await ruffConfigFile(ctx);
  const args = ['format', '--check', '--no-cache', '--output-format', 'json', '--config', config];
  const result = await runTool(ctx, 'ruff', [...args, ...files]);
  if (result.code > 1 && !result.stdout.trimStart().startsWith('[')) {
    throw failed('ruff format', result);
  }
  return parseRuffJson(result.stdout)
    .filter((d) => d.code === 'unformatted')
    .map((d) => ({
      rule: 'ruff/format',
      message: `${lines(d.line, d.endLine)} not formatted the way ruff format writes them.`,
      location: { file: fromTool(ctx, d.file), line: d.line, endLine: d.endLine },
    }));
}
